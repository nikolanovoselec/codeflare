#!/usr/bin/env python3
"""Ask a server directly whether it will speak a legacy TLS version.

The handshake is written by hand over a plain TCP socket rather than driven
through a TLS library, because every library on a current runner refuses to
OFFER TLS 1.0/1.1 -- and a client that will not offer cannot tell you anything
about the server. Raw bytes make the probe independent of local policy: what
comes back is the server's own answer.

Exit 0 when the server refused the version, 1 when it accepted it, 2 when the
answer was neither (never treated as a pass).
"""
import socket
import struct
import sys

# TLS 1.0 and TLS 1.1 wire versions.
VERSIONS = {"1.0": (3, 1), "1.1": (3, 2)}

# Classic suites a TLS 1.0/1.1 server would pick from. The list only has to be
# something a legacy-speaking server could accept; it is not a cipher audit.
CIPHERS = [0xC014, 0xC013, 0x0035, 0x002F, 0x000A]


def is_ip_literal(host: str) -> bool:
    return all(part.isdigit() for part in host.split(".") if part) and host.count(".") == 3


def client_hello(major: int, minor: int, host: str) -> bytes:
    body = struct.pack("!BB", major, minor) + b"\x00" * 32 + b"\x00"
    body += struct.pack("!H", len(CIPHERS) * 2)
    for suite in CIPHERS:
        body += struct.pack("!H", suite)
    body += b"\x01\x00"  # one compression method: null

    # SNI is required to reach the right certificate on a shared edge. It is
    # omitted for an IP literal, which RFC 6066 does not permit as a name.
    extensions = b""
    if not is_ip_literal(host):
        sni_host = host.encode("ascii")
        server_name = b"\x00" + struct.pack("!H", len(sni_host)) + sni_host
        sni = struct.pack("!H", len(server_name)) + server_name
        extensions = b"\x00\x00" + struct.pack("!H", len(sni)) + sni
    body += struct.pack("!H", len(extensions)) + extensions

    handshake = b"\x01" + struct.pack("!I", len(body))[1:] + body
    return b"\x16" + struct.pack("!BB", major, minor) + struct.pack("!H", len(handshake)) + handshake


def probe(host: str, port: int, version: str) -> tuple[int, str]:
    major, minor = VERSIONS[version]
    try:
        with socket.create_connection((host, port), timeout=10) as sock:
            sock.sendall(client_hello(major, minor, host))
            head = sock.recv(5)
    except OSError as exc:
        return 2, f"no answer from {host}:{port} ({exc})"

    if len(head) < 5:
        # A server may also refuse by closing rather than alerting. That is a
        # refusal, but only when it sent nothing at all -- a short read after
        # partial data is unexplained and must not be read as either answer.
        if not head:
            return 0, "connection closed without a handshake (version refused)"
        return 2, f"truncated response ({head!r})"

    content_type = head[0]
    if content_type == 0x15:  # alert
        alert = sock_alert(head)
        return 0, f"alert {alert} (version refused)"
    if content_type == 0x16:  # handshake -> ServerHello
        return 1, "ServerHello returned (version accepted)"
    return 2, f"unexpected record type 0x{content_type:02x}"


def sock_alert(head: bytes) -> str:
    return f"record {head[0]:#04x} version {head[1]}.{head[2]}"


def main() -> int:
    if len(sys.argv) != 3 or sys.argv[2] not in VERSIONS:
        print("usage: tls-legacy-probe.py <host[:port]> <1.0|1.1>", file=sys.stderr)
        return 2
    target, version = sys.argv[1], sys.argv[2]
    host, _, port_text = target.partition(":")
    try:
        port = int(port_text) if port_text else 443
    except ValueError:
        print(f"INCONCLUSIVE: TLS {version} -- '{target}' is not a host or host:port", file=sys.stderr)
        return 2
    code, detail = probe(host, port, version)
    verdict = {0: "PASS", 1: "FAIL", 2: "INCONCLUSIVE"}[code]
    print(f"{verdict}: TLS {version} -- {detail}")
    return code


if __name__ == "__main__":
    sys.exit(main())
