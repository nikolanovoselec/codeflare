"""CI-only LLDB continuation trace for the pinned workerd; never print runtime data."""
import json
from pathlib import Path
import time

import lldb  # Provided by the runner's installed LLDB, not a project dependency.

BUILD_ID = "b78378ab59391d087033a415cd5c11524c729739"
# Pinned KJ http.c++:8073-8076, inlined getImpl() + 0x5a. The standalone
# lambda can be bypassed. This path covers BOTH pipeline timeout and clean
# drain readiness; never label a hit as timer-exclusive or connection-specific.
FALSE_ADDRESS = 0x563C3AA
FALSE_BYTES = bytes.fromhex("c6 80 60 01 00 00 01")
DRAIN_SYMBOL = "_ZN2kj10HttpServer5drainEv"
output = None
hits = 0


def emit(event, **fields):
    output.write(json.dumps({"time": time.time(), "event": event, **fields}) + "\n")
    output.flush()


def on_false(frame, _location, _internal):
    global hits
    hits += 1
    if hits <= 50:
        emit("native-branch", pid=frame.GetThread().GetProcess().GetProcessID(),
             branch="PIPELINE_TIMEOUT_OR_DRAIN_FALSE")
    return False


def on_drain(frame, _location, _internal):
    global hits
    hits += 1
    if hits <= 50:
        emit("native-branch", pid=frame.GetThread().GetProcess().GetProcessID(),
             branch="SERVER_DRAIN_ENTRY")
    return False


def run(pid, directory):
    global output, hits
    directory = Path(directory)
    ready = directory / "native-close-ready.json"
    stop = directory / "native-close-stop"

    def publish_ready(status):
        temporary = ready.with_suffix(".tmp")
        temporary.write_text(json.dumps({"status": status}), encoding="ascii")
        temporary.replace(ready)

    debugger = lldb.debugger
    # Attach synchronously so identity and breakpoint checks see loaded modules.
    debugger.SetAsync(False)
    target = debugger.CreateTarget(None)
    process = None
    with (directory / "native-close.jsonl").open("w", encoding="ascii") as output:
        try:
            error = lldb.SBError()
            process = target.AttachToProcessWithID(debugger.GetListener(), pid, error)
            if error.Fail() or not process.IsValid():
                raise RuntimeError("attach")
            module = target.FindModule(target.GetExecutable())
            if module.GetUUIDString().lower().replace("-", "") != BUILD_ID:
                raise RuntimeError("binary-identity")
            address = module.ResolveFileAddress(FALSE_ADDRESS)
            if not address.IsValid() or process.ReadMemory(address.GetLoadAddress(target),
                                                          len(FALSE_BYTES), error) != FALSE_BYTES or error.Fail():
                raise RuntimeError("branch-bytes")
            false_break = target.BreakpointCreateBySBAddress(address)
            drain_break = target.BreakpointCreateByName(DRAIN_SYMBOL)
            for breakpoint, callback in [(false_break, "on_false"), (drain_break, "on_drain")]:
                if breakpoint.GetNumLocations() != 1:
                    raise RuntimeError("branch-resolution")
                error = breakpoint.SetScriptCallbackBody(
                    f"import native_close_trace\nreturn native_close_trace.{callback}(frame, bp_loc, internal_dict)")
                if error.Fail():
                    raise RuntimeError("callback")
            emit("native-attached", pid=pid, build_id=BUILD_ID)
            debugger.SetAsync(True)
            error = process.Continue()
            if error.Fail():
                raise RuntimeError("continue")
            publish_ready("ready")
            deadline = time.monotonic() + 80
            stopped_since = None
            event = lldb.SBEvent()
            listener = debugger.GetListener()
            while not stop.exists() and time.monotonic() < deadline and hits < 50:
                # Consume public state events while the embedded script owns the
                # CLI thread; otherwise GetState() can retain the attach stop.
                while listener.GetNextEvent(event):
                    pass
                state = process.GetState()
                if state in (lldb.eStateExited, lldb.eStateDetached):
                    break
                if state in (lldb.eStateStopped, lldb.eStateCrashed, lldb.eStateSuspended):
                    stopped_since = stopped_since or time.monotonic()
                    if time.monotonic() - stopped_since > 1:
                        raise RuntimeError("unexpected-stop")
                else:
                    stopped_since = None
                time.sleep(0.05)
        except Exception as error:
            # Only our fixed error labels can leave the debugger process.
            allowed = {"attach", "binary-identity", "branch-bytes", "branch-resolution", "callback", "continue", "unexpected-stop"}
            label = str(error) if str(error) in allowed else "debugger-api"
            emit("native-trace-error", stage=label)
            if not ready.exists():
                publish_ready("error")
        finally:
            if process and process.IsValid() and process.GetState() not in (lldb.eStateExited, lldb.eStateDetached):
                error = process.Detach()
                emit("native-detached", pid=pid, success=error.Success())
            emit("native-trace-ended", hits=min(hits, 50))
