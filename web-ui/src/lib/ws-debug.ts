// On-screen WebSocket frame counter overlay.
//
// Activated by `?wsdebug=1` URL parameter. Top-left, identical style to the
// viewport debug overlay in lib/mobile.ts. Tracks bytes received from the
// terminal WebSocket vs bytes actually written to xterm to distinguish
// wire-level frame duplication from xterm render-side artifacts.
//
// In normal operation (no URL param) this module is a no-op: the recording
// functions return immediately and no DOM element is created. Permanent in
// the codebase, gated solely by the URL parameter.
//
// Diagnostic-only — observes the WS-receive path and the xterm write-batch
// flush path without implementing any AC. No REQ annotation.

const enabled =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).has('wsdebug');

interface PerKeyCounters {
  recvUnits: number;       // length of decoded message strings (chars)
  recvFrames: number;      // number of WS messages received
  writeUnits: number;      // length of strings passed to terminal.write()
  writeFlushes: number;    // number of flush cycles
  recentRecvTimestamps: number[]; // for frames/sec rate display
  // Restore-frame diagnostics. A `restore` is the JSON control message
  // the host sends on every WS attach to repaint the saved scrollback.
  // restoreCount scales with how often the WS reconnects in the session.
  // claudeSig in the most recent restore is the "duplication signature":
  //   1  = server's saved state has one Claude Code session header
  //  >1  = server's saved state already contains duplicated content
  restoreCount: number;
  lastRestoreSize: number;
  lastRestoreClaudeSig: number;
}

const counters = new Map<string, PerKeyCounters>();

function getCounters(key: string): PerKeyCounters {
  let c = counters.get(key);
  if (!c) {
    c = {
      recvUnits: 0,
      recvFrames: 0,
      writeUnits: 0,
      writeFlushes: 0,
      recentRecvTimestamps: [],
      restoreCount: 0,
      lastRestoreSize: 0,
      lastRestoreClaudeSig: 0,
    };
    counters.set(key, c);
  }
  return c;
}

export function recordFrame(key: string, length: number): void {
  if (!enabled) return;
  const c = getCounters(key);
  c.recvUnits += length;
  c.recvFrames += 1;
  const now = Date.now();
  c.recentRecvTimestamps.push(now);
  // Keep a rolling 10-second window
  const cutoff = now - 10_000;
  while (c.recentRecvTimestamps.length > 0 && c.recentRecvTimestamps[0] < cutoff) {
    c.recentRecvTimestamps.shift();
  }
}

export function recordFlush(key: string, length: number): void {
  if (!enabled) return;
  const c = getCounters(key);
  c.writeUnits += length;
  c.writeFlushes += 1;
}

// Records a restore JSON control message arriving on the WS.
// claudeSig is the count of "Claude Code v" substrings in the saved state —
// a 1 means the server's state has a single (correct) Claude Code session
// header; >1 means the server is shipping already-duplicated content.
export function recordRestore(key: string, stateLength: number, claudeSig: number): void {
  if (!enabled) return;
  const c = getCounters(key);
  c.restoreCount += 1;
  c.lastRestoreSize = stateLength;
  c.lastRestoreClaudeSig = claudeSig;
}

if (enabled && typeof document !== 'undefined') {
  const overlay = document.createElement('div');
  overlay.id = 'ws-debug-overlay';
  Object.assign(overlay.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    zIndex: '99998',
    background: 'rgba(0,0,0,0.85)',
    color: '#0f0',
    fontFamily: 'monospace',
    fontSize: '11px',
    lineHeight: '1.4',
    padding: '6px 10px',
    pointerEvents: 'none',
    whiteSpace: 'pre',
    maxWidth: '100vw',
    borderBottomRightRadius: '6px',
  });

  function attachWhenReady() {
    if (document.body) {
      document.body.appendChild(overlay);
    } else {
      window.addEventListener('DOMContentLoaded', () => document.body.appendChild(overlay), { once: true });
    }
  }
  attachWhenReady();

  function update() {
    let totalRecvUnits = 0;
    let totalWriteUnits = 0;
    let totalFrames = 0;
    let totalFlushes = 0;
    let totalRateLast10s = 0;
    let totalRestores = 0;
    let lastRestoreSize = 0;
    let lastRestoreClaudeSig = 0;
    const lines: string[] = [];

    for (const [key, c] of counters) {
      totalRecvUnits += c.recvUnits;
      totalWriteUnits += c.writeUnits;
      totalFrames += c.recvFrames;
      totalFlushes += c.writeFlushes;
      totalRateLast10s += c.recentRecvTimestamps.length;
      totalRestores += c.restoreCount;
      // For "last restore" surface across all keys, take the largest seen
      // since the most recent restore is the most diagnostic signal.
      if (c.lastRestoreSize > lastRestoreSize) {
        lastRestoreSize = c.lastRestoreSize;
        lastRestoreClaudeSig = c.lastRestoreClaudeSig;
      }
      const drift = c.recvUnits - c.writeUnits;
      const rate = c.recentRecvTimestamps.length / 10;
      const shortKey = key.split(':').map((s) => s.slice(0, 6)).join(':');
      lines.push(
        `${shortKey} f=${c.recvFrames} fl=${c.writeFlushes} d=${drift >= 0 ? '+' + drift : drift} r=${rate.toFixed(1)}/s rst=${c.restoreCount}/sig=${c.lastRestoreClaudeSig}`
      );
    }

    const overallDrift = totalRecvUnits - totalWriteUnits;
    const overallRate = totalRateLast10s / 10;
    overlay.textContent =
      `WS DEBUG (?wsdebug=1)\n` +
      `recv:    ${totalRecvUnits} units / ${totalFrames} frames\n` +
      `written: ${totalWriteUnits} units / ${totalFlushes} flushes\n` +
      `drift:   ${overallDrift >= 0 ? '+' + overallDrift : overallDrift}\n` +
      `rate:    ${overallRate.toFixed(1)} frames/sec (last 10s)\n` +
      `restores:${totalRestores} (last ${lastRestoreSize}B, claude-sig=${lastRestoreClaudeSig})\n` +
      `\nper-terminal:\n` +
      (lines.length > 0 ? lines.join('\n') : '(none yet)');
  }

  setInterval(update, 1000);
  update();
}
