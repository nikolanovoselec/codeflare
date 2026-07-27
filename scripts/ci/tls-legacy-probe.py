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
import ipaddress
import socket
import struct
import sys

# TLS 1.0 and TLS 1.1 wire versions.
VERSIONS = {"1.0": (3, 1), "1.1": (3, 2)}

# Only these two alerts say "not this version". Everything else is the server
# declining for some other reason -- most often handshake_failure, which is what
# a server that DOES speak the version answers when it likes none of the suites
# below. Reading any alert as a refusal would pass exactly the case this check
# exists to catch.
VERSION_REFUSAL_ALERTS = {70: "protocol_version", 71: "insufficient_security"}
OTHER_ALERTS = {40: "handshake_failure", 47: "illegal_parameter", 112: "unrecognized_name"}

# Classic suites a TLS 1.0/1.1 server would pick from. The list only has to be
# something a legacy-speaking server could accept; it is not a cipher audit.
CIPHERS = [0xC014, 0xC013, 0x0035, 0x002F, 0x000A]


def is_ip_literal(host: str) -> bool:
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return False
    return True


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


def read_exactly(sock: socket.socket, count: int) -> bytes:
    """Read count bytes, or fewer if the peer closes. recv may return a short
    read on a stream socket, and treating a segmented record header as a
    malformed one would fail the weekly job on transport timing alone."""
    buffer = b""
    while len(buffer) < count:
        chunk = sock.recv(count - len(buffer))
        if not chunk:
            break
        buffer += chunk
    return buffer


def probe(host: str, port: int, version: str) -> tuple[int, str]:
    major, minor = VERSIONS[version]
    try:
        with socket.create_connection((host, port), timeout=10) as sock:
            sock.sendall(client_hello(major, minor, host))
            head = read_exactly(sock, 5)
            # An alert body is 2 bytes; a ServerHello needs 6 to reach the
            # negotiated version. Bounded by the record's own length so a short
            # record cannot make this block waiting for bytes never sent.
            want = {0x15: 2, 0x16: 6}.get(head[0], 0) if len(head) == 5 else 0
            record_length = ((head[3] << 8) | head[4]) if len(head) == 5 else 0
            body = read_exactly(sock, min(want, record_length)) if want else b""
    except OSError as exc:
        return 2, f"no answer from {host}:{port} ({exc})"

    if len(head) < 5:
        # A close with no answer is not evidence either way: a server refusing
        # the version, a middlebox reset and a connection dropped in transit all
        # look identical from here.
        if not head:
            return 2, "connection closed without answering"
        return 2, f"truncated response ({head!r})"

    content_type = head[0]
    if content_type == 0x15:  # alert
        if len(body) < 2:
            return 2, "alert record with no description"
        level, description = body[0], body[1]
        if description in VERSION_REFUSAL_ALERTS:
            return 0, f"alert {VERSION_REFUSAL_ALERTS[description]}({description}) (version refused)"
        named = OTHER_ALERTS.get(description, "unknown")
        # A server that speaks this version answers handshake_failure when it
        # likes none of the offered suites, so this says nothing about version
        # support and must not be read as a refusal.
        return 2, f"alert {named}({description}) level {level}: not a version refusal"
    if content_type == 0x16:  # handshake -> ServerHello
        # Any handshake record means the server is proceeding, so the verdict is
        # settled here and stays settled -- a server that answers a TLS 1.0
        # hello by negotiating something even older has still accepted a legacy
        # version, and reporting that as inconclusive would hide the worse case.
        # Only the version NAMED in the message is read from the body: head[1:3]
        # is the record layer, which servers set for compatibility and which is
        # routinely not what was negotiated.
        if len(body) >= 6 and body[0] == 0x02:
            return 1, f"ServerHello negotiated {body[4]}.{body[5]} (version accepted)"
        return 1, "handshake record returned (version accepted)"
    return 2, f"unexpected record type 0x{content_type:02x}"


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
