"""Temporary loopback connection metadata; never read beyond base IPv4/TCP headers."""
import json
import os
from pathlib import Path
import re
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
                if not flags:
                    continue
                source, destination, sequence, acknowledgement = struct.unpack_from("!HHII", packet, 20)
                emit("tcp", source=source, destination=destination, flags=flags,
                     sequence=sequence, acknowledgement=acknowledgement)
                count += 1
            reason = "signal" if not running else "limit" if count == 5000 else "deadline"
        finally:
            emit("ended", packets=count, reason=reason)
            pidfile.unlink(missing_ok=True)


if __name__ == "__main__":
    capture()
