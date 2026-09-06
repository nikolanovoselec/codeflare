#!/usr/bin/env python3
"""CI-only real bisync/S3 regression, using isolated files and dummy credentials."""
import collections
import http.client
import http.server
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import threading
import time

binary = str(Path(sys.argv[1]).resolve())
counts = collections.Counter()
race_file = None
race_armed = False


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


backend_port = free_port()


class Proxy(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def forward(self):
        global race_armed
        counts[self.command] += 1
        if self.command == "GET" and ("list-type=" in self.path or "delimiter=" in self.path):
            counts["LIST"] += 1
        if self.command == "HEAD" and race_armed and self.path.split("?")[0] == "/bucket/racing.jsonl":
            rival = http.client.HTTPConnection("127.0.0.1", backend_port, timeout=30)
            rival.request("PUT", "/bucket/racing.jsonl", b"other writer\n")
            response = rival.getresponse()
            response.read()
            assert response.status < 300
            rival.close()
            race_armed = False
        data = self.rfile.read(int(self.headers.get("Content-Length", "0")))
        connection = http.client.HTTPConnection("127.0.0.1", backend_port, timeout=30)
        try:
            # serve s3 otherwise maps the mtime metadata onto the local file's
            # LastModified. Real S3 does not: emulate its server-time semantics.
            # The isolated loopback fixture permits anonymous requests only here.
            headers = {name: value for name, value in self.headers.items()
                       if name.lower() not in ("x-amz-meta-mtime", "authorization")}
            headers["Connection"] = "close"
            connection.request(self.command, self.path, data, headers)
            response = connection.getresponse()
            body = response.read()
            if (self.command == "PUT" and "partNumber=" not in self.path or self.command == "POST" and "uploadId=" in self.path) and race_file is not None and self.path.split("?")[0] == "/bucket/racing.jsonl" and response.status < 300:
                race_armed = True
            self.send_response(response.status)
            for name, value in response.getheaders():
                if name.lower() not in ("connection", "transfer-encoding"):
                    self.send_header(name, value)
            self.end_headers()
            self.wfile.write(body)
        finally:
            connection.close()

    do_GET = do_HEAD = do_PUT = do_POST = do_DELETE = forward


def test_server_modtime_sync():
    """REQ-STOR-003 / REQ-STOR-040: real per-side bookkeeping, conflict preservation and request bounds."""
    global race_file
    with tempfile.TemporaryDirectory(prefix="rclone-bisync-ci-") as directory:
        root = Path(directory)
        local = root / "local"
        local.mkdir()
        server_root = root / "server"
        (server_root / "bucket").mkdir(parents=True)
        proxy = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Proxy)
        thread = threading.Thread(target=proxy.serve_forever, daemon=True)
        thread.start()
        config = root / "rclone.conf"
        config.write_text(f"[fixture]\ntype = s3\nprovider = Other\naccess_key_id = fixture\nsecret_access_key = fixture\nendpoint = http://127.0.0.1:{proxy.server_port}\nforce_path_style = true\nno_check_bucket = true\nuse_multipart_etag = false\n")
        server_log = (root / "server.log").open("wb")
        server = subprocess.Popen([binary, "serve", "s3", str(server_root), "--addr", f"127.0.0.1:{backend_port}"], stdout=server_log, stderr=subprocess.STDOUT)

        def run(*args, data=None):
            result = subprocess.run([binary, "--config", str(config), "--retries", "1", "--low-level-retries", "1", *args], input=data, capture_output=True, timeout=90)
            if result.returncode:
                raise RuntimeError(f"rclone {args} failed:\n{result.stderr.decode()}")
            return result.stdout

        def sync(*args):
            return run("bisync", str(local), "fixture:bucket", "--workdir", str(root / "state"), "--use-server-modtime", "--fast-list", "--check-sync=false", "--ignore-checksum", "--conflict-resolve", "newer", *args)

        try:
            for _ in range(100):
                if server.poll() is not None:
                    raise RuntimeError("S3 fixture exited: " + (root / "server.log").read_text())
                try:
                    with socket.create_connection(("127.0.0.1", backend_port), timeout=0.1):
                        break
                except OSError:
                    time.sleep(0.1)
            else:
                raise RuntimeError("S3 fixture did not become ready")
            transcript = local / "session.jsonl"
            transcript.write_bytes(b"original\n")
            os.utime(transcript, (time.time() - 600, time.time() - 600))
            for index in range(12):
                (local / f"unchanged-{index}").write_text("unchanged\n")
            # One remote-origin file stays unchanged even with the unpatched bug,
            # so the all-files-changed guard does not mask the intended reproduction.
            run("rcat", "fixture:bucket/sentinel", data=b"unchanged remote anchor\n")
            sync("--resync")
            time.sleep(1.1)
            transcript.write_bytes(b"original\nappend\n")
            before = counts.copy()
            sync()
            changed = counts - before
            conflicts = bool(list(local.glob("*.conflict*"))) or b"conflict" in run("lsf", "fixture:bucket")
            if "--expect-false-conflict" in sys.argv:
                assert conflicts, "Unpatched rclone no longer reproduces the bug; review/remove the patch"
                print("RED: unpatched rclone reproduced an own-upload false conflict")
                return
            assert not conflicts, "Own upload caused false conflict copies"
            assert changed["HEAD"] <= 4, f"One upload introduced unrelated HEAD requests: {changed}"
            assert run("cat", "fixture:bucket/session.jsonl") == transcript.read_bytes()
            before = counts.copy()
            sync()
            idle = counts - before
            assert idle["HEAD"] <= 1, f"Unchanged cycle introduced metadata HEAD scan: {idle}"
            # Same-size remote edits must still be detected by server modification time.
            time.sleep(1.1)
            remote = b"remote--\nchange\n"
            assert len(remote) == transcript.stat().st_size
            run("rcat", "fixture:bucket/session.jsonl", data=remote)
            sync()
            assert transcript.read_bytes() == remote, "Same-size remote edit was lost"
            # Simultaneous divergence must preserve both versions, including the loser.
            time.sleep(1.1)
            ours, theirs = b"local divergent\n", b"other divergent\n"
            transcript.write_bytes(ours)
            os.utime(transcript, (time.time() - 120, time.time() - 120))
            run("rcat", "fixture:bucket/session.jsonl", data=theirs)
            sync()
            assert transcript.read_bytes() == theirs, "Newer remote version did not win"
            versions = {path.read_bytes() for path in local.glob("session*")}
            assert {ours, theirs}.issubset(versions), "Genuine divergent content was discarded"
            names = set(path.name for path in local.glob("session*"))
            for _ in range(2):
                sync()
                assert set(path.name for path in local.glob("session*")) == names, "Conflict copies multiplied on an unchanged cycle"
                assert {ours, theirs}.issubset({path.read_bytes() for path in local.glob("session*")})
            # Exercise both native multipart and generic OpenChunkWriter, at bounded sizes.
            large = root / "large.bin"
            large.write_bytes(b"0123456789abcdef" * (6 * 1024 * 1024 // 16))
            for streams in ("0", "2"):
                destination = f"fixture:bucket/large-{streams}.bin"
                run("copyto", str(large), destination, "--use-server-modtime", "--s3-upload-cutoff", "5Mi", "--s3-chunk-size", "5Mi", "--multi-thread-cutoff", "1Mi", "--multi-thread-streams", streams)
                assert run("cat", destination) == large.read_bytes(), "Large transfer changed content"
            # Another writer between PUT and HEAD cannot be accepted as our upload.
            racing_source = root / "racing.jsonl"
            racing_source.write_bytes(b"our upload--\n")
            race_file = server_root / "bucket/racing.jsonl"
            for mode in ("single", "multipart", "multithread", "server-copy", "multipart-server-copy"):
                extra = ["--use-server-modtime"]
                source = str(racing_source)
                if mode in ("multipart", "multithread"):
                    source = str(large)
                    extra += ["--s3-upload-cutoff", "5Mi", "--s3-chunk-size", "5Mi", "--multi-thread-cutoff", "1Mi", "--multi-thread-streams", "0" if mode == "multipart" else "2"]
                elif mode in ("server-copy", "multipart-server-copy"):
                    source = "fixture:bucket/large-0.bin"
                    if mode == "multipart-server-copy":
                        extra += ["--s3-copy-cutoff", "5Mi"]
                try:
                    run("copyto", source, "fixture:bucket/racing.jsonl", *extra)
                except RuntimeError as error:
                    assert "object identity changed after upload" in str(error), str(error)
                else:
                    raise AssertionError(f"Post-upload writer was silently acknowledged: {mode}")
                assert race_file.read_bytes() == b"other writer\n", "Concurrent writer was deleted"
            print(f"PASS: resync, own-upload append, same-size remote edit, divergence, PUT/HEAD race; idle={dict(idle)}, upload={dict(changed)}")
        finally:
            server.terminate()
            server.wait(timeout=10)
            server_log.close()
            proxy.shutdown()
            proxy.server_close()


if __name__ == "__main__":
    test_server_modtime_sync()
