"""Temporary loopback connection metadata; never read beyond base IPv4/TCP headers."""
import json
import os
from pathlib import Path
import re
import shlex
import signal
import socket
import struct
import subprocess
import sys
import time


def capture():
    running = True

    def stop(_signum, _frame):
        nonlocal running
        running = False

    def emit(event, **fields):
        print(json.dumps({"time": time.time(), "event": event, **fields}), flush=True)

    signal.signal(signal.SIGTERM, stop)
    pidfile = Path(sys.argv[1])
    deadline = time.monotonic() + 180
    listeners = set()
    next_listeners = 0
    count = 0
    reason = "error"
    trace = None
    trace_user_pid = None
    trace_pairs = set()
    directory = pidfile.parent
    arm = directory / "native-close-arm.json"
    stop_trace = directory / "native-close-stop"

    def connection_pairs(sockets, user_pid):
        listening = {(local, pid) for local, _peer, state, name, pid in sockets
                     if state == "LISTEN" and name == "workerd"}
        connected = {(local, peer): pid for local, peer, state, name, pid in sockets
                     if state == "ESTAB" and name == "workerd"}
        return {(int(local.rsplit(":", 1)[1]), int(peer.rsplit(":", 1)[1]))
                for (local, peer), owner in connected.items()
                if owner == user_pid and (local, owner) in listening
                and connected.get((peer, local)) not in (None, owner)}

    def start_trace(sockets):
        nonlocal trace_user_pid
        # The receiving workerd owns a listening endpoint whose connected peer
        # belongs to the other workerd. This is the proved Proxy -> User edge.
        node_pid = json.loads(arm.read_text(encoding="ascii"))["nodePid"]
        if (type(node_pid) is not int or node_pid <= 1
                or Path(f"/proc/{node_pid}/exe").readlink().name != "node"):
            raise ValueError("Invalid native trace owner")
        listening = {(local, pid) for local, _peer, state, name, pid in sockets
                     if state == "LISTEN" and name == "workerd"}
        connected = {(local, peer): pid for local, peer, state, name, pid in sockets
                     if state == "ESTAB" and name == "workerd"}
        candidates = set()
        for (local, peer), pid in connected.items():
            other = connected.get((peer, local))
            if (local, pid) in listening and other is not None and other != pid:
                try:
                    fields = Path(f"/proc/{pid}/stat").read_text().rpartition(")")[2].split()
                    executable = Path(f"/proc/{pid}/exe").readlink()
                except (FileNotFoundError, ProcessLookupError):
                    continue  # Other files' independently owned runtimes can exit.
                modules = Path(__file__).resolve().parents[2] / "node_modules"
                if (int(fields[1]) == node_pid and executable.name == "workerd"
                        and executable.is_relative_to(modules)):
                    candidates.add(pid)
        if len(candidates) != 1:
            return None
        pid = candidates.pop()
        trace_user_pid = pid
        script = Path(__file__).resolve().with_name("native_close_trace.py")
        return subprocess.Popen(["lldb-18", "--no-lldbinit", "--batch", "-o",
                                 "command script import " + shlex.quote(str(script)), "-o",
                                 f"script native_close_trace.run({pid}, {str(directory)!r})"],
                                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    # SOCK_RAW/IPPROTO_TCP receives IP packets, without an Ethernet header.
    # recv(40) copies at most 20 IPv4 + 20 TCP bytes. IP options are rejected.
    with socket.socket(socket.AF_INET, socket.SOCK_RAW, socket.IPPROTO_TCP) as stream:
        stream.bind(("127.0.0.1", 0))
        stream.settimeout(0.2)
        pidfile.write_text(str(os.getpid()), encoding="ascii")
        emit("started", pid=os.getpid(), header_bytes=40)
        try:
            while running and time.monotonic() < deadline and count < 5000:
                if time.monotonic() >= next_listeners:
                    result = subprocess.run(["ss", "-H", "-antp"], check=True,
                                            capture_output=True, text=True, timeout=2)
                    current = set()
                    for line in result.stdout.splitlines():
                        fields = line.split(None, 5)
                        if len(fields) < 6 or not fields[3].startswith("127.0.0.1:"):
                            continue
                        if fields[0] != "LISTEN" and not fields[4].startswith("127.0.0.1:"):
                            continue
                        for name, pid in re.findall(r'"(node|workerd)",pid=(\d+)', fields[5]):
                            current.add((fields[3], fields[4], fields[0], name, int(pid)))
                    if current != listeners:
                        emit("sockets", sockets=sorted(current))
                        listeners = current
                    if trace is None and arm.exists() and time.time() - arm.stat().st_mtime < 10:
                        trace = start_trace(current)
                    if trace is not None and trace.poll() is None:
                        trace_pairs = connection_pairs(current, trace_user_pid)
                    next_listeners = time.monotonic() + 0.5
                try:
                    packet = stream.recv(40)
                except socket.timeout:
                    continue
                if len(packet) != 40 or packet[0] != 0x45 or packet[9] != socket.IPPROTO_TCP:
                    continue
                if packet[12:16] != b"\x7f\x00\x00\x01" or packet[16:20] != b"\x7f\x00\x00\x01":
                    continue
                if struct.unpack_from("!H", packet, 6)[0] & 0x3FFF or packet[32] >> 4 < 5:
                    continue
                flags = packet[33] & 0x07
                source, destination, sequence, acknowledgement = struct.unpack_from("!HHII", packet, 20)
                # Derive payload LENGTH solely from the copied base headers.
                # Scope data-arrival metadata to the one traced User runtime.
                data_bytes = struct.unpack_from("!H", packet, 2)[0] - 20 - (packet[32] >> 4) * 4
                if (trace is not None and trace.poll() is None and data_bytes > 0
                        and ((source, destination) in trace_pairs or (destination, source) in trace_pairs)):
                    emit("tcp-data-header", source=source, destination=destination,
                         sequence=sequence, acknowledgement=acknowledgement, data_bytes=data_bytes)
                    count += 1
                if flags and count < 5000:
                    emit("tcp", source=source, destination=destination, flags=flags,
                         sequence=sequence, acknowledgement=acknowledgement)
                    count += 1
            reason = "signal" if not running else "limit" if count == 5000 else "deadline"
        finally:
            stop_trace.touch()
            if trace is not None:
                try:
                    trace.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    # Never kill an attached debugger/inferior. Its own deadline
                    # still performs detach; disclose incomplete cleanup.
                    emit("native-trace-cleanup-error", stage="detach-deadline")
            emit("ended", packets=count, reason=reason)
            pidfile.unlink(missing_ok=True)


if __name__ == "__main__":
    capture()
