"""Temporary loopback/header and procfs metadata; no payload or debugger attachment."""
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
    user_pid = None
    user_start = None
    runtime_deadline = None
    runtime_ended = False
    pairs = set()
    arm = pidfile.parent / "native-runtime-arm.json"
    ticks_per_second = os.sysconf("SC_CLK_TCK")
    page_size = os.sysconf("SC_PAGE_SIZE")
    schedstats_file = Path("/proc/sys/kernel/sched_schedstats")
    schedstats_enabled = schedstats_file.exists() and schedstats_file.read_text().strip() == "1"

    def connection_pairs(sockets, pid):
        listening = {(local, owner) for local, _peer, state, name, owner in sockets
                     if state == "LISTEN" and name == "workerd"}
        connected = {(local, peer): owner for local, peer, state, name, owner in sockets
                     if state == "ESTAB" and name == "workerd"}
        return {(int(local.rsplit(":", 1)[1]), int(peer.rsplit(":", 1)[1]))
                for (local, peer), owner in connected.items()
                if owner == pid and (local, owner) in listening
                and connected.get((peer, local)) not in (None, owner)}

    def select_runtime(sockets):
        # The receiving workerd owns the listening side of the Proxy -> User
        # connection. Require the armed fixture Node parent and repo executable.
        node_pid = json.loads(arm.read_text(encoding="ascii"))["nodePid"]
        if (type(node_pid) is not int or node_pid <= 1
                or Path(f"/proc/{node_pid}/exe").readlink().name != "node"):
            raise ValueError("Invalid native runtime owner")
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
                    continue  # Independently owned runtimes can exit.
                modules = Path(__file__).resolve().parents[2] / "node_modules"
                if (int(fields[1]) == node_pid and executable.name == "workerd"
                        and executable.is_relative_to(modules)):
                    candidates.add((pid, int(fields[19])))
        if len(candidates) != 1:
            return None
        pid, started = candidates.pop()
        emit("runtime-selected", pid=pid, node_pid=node_pid,
             ticks_per_second=ticks_per_second, schedstats_enabled=schedstats_enabled,
             sample_interval_ms=500, window_seconds=80)
        return pid, started

    def sample_runtime():
        nonlocal runtime_ended
        if runtime_ended:
            return
        if time.monotonic() >= runtime_deadline:
            emit("runtime-ended", pid=user_pid, reason="window")
            runtime_ended = True
            return
        try:
            process = Path(f"/proc/{user_pid}/stat").read_text().rpartition(")")[2].split()
            main = Path(f"/proc/{user_pid}/task/{user_pid}/stat").read_text().rpartition(")")[2].split()
            schedule = Path(f"/proc/{user_pid}/task/{user_pid}/schedstat").read_text().split()
        except (FileNotFoundError, ProcessLookupError):
            emit("runtime-ended", pid=user_pid, reason="exited")
            runtime_ended = True
            return
        if int(process[19]) != user_start:
            raise ValueError("Native runtime PID reused")
        # Fixed numeric/state fields only: no argv, thread names, stacks, locals,
        # file contents, credentials, request headers or application values.
        emit("runtime-process", pid=user_pid, main_state=main[0],
             main_cpu_ticks=int(main[11]) + int(main[12]),
             process_cpu_ticks=int(process[11]) + int(process[12]),
             main_run_ns=int(schedule[0]),
             main_runqueue_wait_ns=int(schedule[1]) if schedstats_enabled else None,
             resident_bytes=int(process[21]) * page_size, threads=int(process[17]))

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
                    if user_pid is None and arm.exists() and time.time() - arm.stat().st_mtime < 10:
                        selected = select_runtime(current)
                        if selected is not None:
                            user_pid, user_start = selected
                            runtime_deadline = time.monotonic() + 80
                    if user_pid is not None:
                        sample_runtime()
                        pairs = set() if runtime_ended else connection_pairs(current, user_pid)
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
                # Scope data-arrival metadata to the identified User runtime.
                data_bytes = struct.unpack_from("!H", packet, 2)[0] - 20 - (packet[32] >> 4) * 4
                if (data_bytes > 0
                        and ((source, destination) in pairs or (destination, source) in pairs)):
                    emit("tcp-data-header", source=source, destination=destination,
                         sequence=sequence, acknowledgement=acknowledgement, data_bytes=data_bytes)
                    count += 1
                if flags and count < 5000:
                    emit("tcp", source=source, destination=destination, flags=flags,
                         sequence=sequence, acknowledgement=acknowledgement)
                    count += 1
            reason = "signal" if not running else "limit" if count == 5000 else "deadline"
        finally:
            if user_pid is not None and not runtime_ended:
                emit("runtime-ended", pid=user_pid, reason="probe-ended")
            emit("ended", packets=count, reason=reason)
            pidfile.unlink(missing_ok=True)


if __name__ == "__main__":
    capture()
