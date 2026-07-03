import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildVaultPrewarmUrl,
  FOCUS_RECLAIM_POLL_MS,
  startVaultPrewarm,
  VAULT_PREWARM_ID_QUERY,
  VAULT_PREWARM_QUERY,
  VAULT_PREWARM_SOURCE,
} from '../../lib/vault-prewarm';

function currentIframe(): HTMLIFrameElement | null {
  return document.querySelector('iframe[title="Vault prewarm"]');
}

const readyProof = {
  ready: true,
  recordedDbs: ['sb_data_abc', 'sb_files_def'],
  hasIndexedDbDatabasesApi: true,
  contentReady: true,
  spaceSyncCompleted: true,
  indexReady: true,
  requiredFiles: ['CONFIG.md', 'Index.md', 'STYLES.md'],
  listedFileCount: 12,
};

const localOnlyProof = {
  ready: true,
  recordedDbs: ['sb_data_abc', 'sb_files_def'],
  hasIndexedDbDatabasesApi: true,
};

// REQ-VAULT-018: Vault control gating and on-demand prewarm trigger

describe('REQ-MOB-014 / REQ-VAULT-020: vault browser prewarm protocol', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.useRealTimers();
    // Restore every vi.spyOn so a spy installed in one test (e.g. the AC5
    // window.focus spy) cannot leak its call record into the next test, which
    // re-spies the same global method and would otherwise inherit those calls.
    vi.restoreAllMocks();
    document.body.innerHTML = '';
  });

  it('builds a bootstrap URL that preserves the prewarm handshake parameters', () => {
    const url = new URL(buildVaultPrewarmUrl('sess1234', 'warm-1'), window.location.origin);

    expect(url.pathname).toBe('/api/vault/sess1234/.codeflare-bootstrap');
    expect(url.searchParams.get(VAULT_PREWARM_QUERY)).toBe('1');
    expect(url.searchParams.get(VAULT_PREWARM_ID_QUERY)).toBe('warm-1');
  });

  it('creates one hidden iframe for the requested session', () => {
    const onReady = vi.fn();
    const onError = vi.fn();

    startVaultPrewarm({ sessionId: 'sess1234', prewarmId: 'warm-1', onReady, onError });

    const iframe = currentIframe();
    expect(iframe).toBeInstanceOf(HTMLIFrameElement);
    expect(document.querySelectorAll('iframe[title="Vault prewarm"]')).toHaveLength(1);
    expect(iframe?.getAttribute('aria-hidden')).toBe('true');
    expect(iframe?.hasAttribute('inert')).toBe(true);
    expect(iframe?.tabIndex).toBe(-1);
    const url = new URL(iframe?.src ?? '', window.location.origin);
    expect(url.pathname).toBe('/api/vault/sess1234/.codeflare-bootstrap');
    expect(url.searchParams.get(VAULT_PREWARM_ID_QUERY)).toBe('warm-1');
  });

  it('keeps prewarm eager while terminal input is focused', () => {
    const onReady = vi.fn();
    const onError = vi.fn();
    const input = document.createElement('textarea');
    input.className = 'xterm-helper-textarea';
    document.body.append(input);
    input.focus();

    startVaultPrewarm({ sessionId: 'sess1234', prewarmId: 'warm-1', onReady, onError });

    expect(currentIframe()).toBeInstanceOf(HTMLIFrameElement);
    expect(document.activeElement).toBe(input);
    expect(onReady).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('restores prior focus if the hidden prewarm iframe captures parent focus', () => {
    const onReady = vi.fn();
    const onError = vi.fn();
    const input = document.createElement('textarea');
    input.className = 'xterm-helper-textarea';
    document.body.append(input);
    input.focus();

    startVaultPrewarm({ sessionId: 'sess1234', prewarmId: 'warm-1', onReady, onError });
    const iframe = currentIframe();
    if (!iframe) throw new Error('prewarm iframe missing');

    // Drive the "iframe captured parent focus" precondition explicitly — jsdom does
    // not move activeElement into a child browsing context via .focus(), so without
    // it the restore path never runs and the assertion would pass on a no-op.
    const inputFocus = vi.spyOn(input, 'focus');
    const activeGet = vi.spyOn(document, 'activeElement', 'get').mockReturnValue(iframe);
    iframe.dispatchEvent(new FocusEvent('focus'));
    activeGet.mockRestore();

    expect(inputFocus).toHaveBeenCalled();
    expect(currentIframe()).toBe(iframe);
    expect(onReady).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('restores focus to the terminal even when it gains focus AFTER prewarm starts (live tracking, not a start-time snapshot)', () => {
    const onReady = vi.fn();
    const onError = vi.fn();
    // Prewarm begins (vault went ready in the background) while a non-terminal
    // element holds focus — the state a start-time snapshot would lock onto.
    const earlier = document.createElement('button');
    document.body.append(earlier);
    earlier.focus();
    const earlierFocus = vi.spyOn(earlier, 'focus');

    startVaultPrewarm({ sessionId: 'sess1234', prewarmId: 'warm-1', onReady, onError });

    // The user THEN enters the terminal view and the xterm textarea takes focus.
    const terminal = document.createElement('textarea');
    terminal.className = 'xterm-helper-textarea';
    document.body.append(terminal);
    terminal.focus();
    expect(document.activeElement).toBe(terminal);
    const terminalFocus = vi.spyOn(terminal, 'focus');

    // SilverBullet inside the prewarm iframe captures parent focus late. Drive that
    // precondition explicitly (jsdom will not focus a child browsing context), so the
    // restore path is genuinely exercised instead of passing on a no-op.
    const iframe = currentIframe();
    if (!iframe) throw new Error('prewarm iframe missing');
    const activeGet = vi.spyOn(document, 'activeElement', 'get').mockReturnValue(iframe);
    iframe.dispatchEvent(new FocusEvent('focus'));
    activeGet.mockRestore();

    // Restore targets the LIVE terminal, never the stale element focused when prewarm
    // started — the old start-time-snapshot implementation would call earlier.focus().
    expect(terminalFocus).toHaveBeenCalled();
    expect(earlierFocus).not.toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('reclaims focus on focusout — the signal that actually fires when a same-origin iframe steals focus (REQ-VAULT-020 AC3)', () => {
    const onReady = vi.fn();
    const onError = vi.fn();
    const input = document.createElement('textarea');
    input.className = 'xterm-helper-textarea';
    document.body.append(input);
    input.focus();

    startVaultPrewarm({ sessionId: 'sess1234', prewarmId: 'warm-1', onReady, onError });
    const iframe = currentIframe();
    if (!iframe) throw new Error('prewarm iframe missing');

    // When SilverBullet calls element.focus() inside the same-origin prewarm iframe,
    // the browser fires `focusout` on the blurring terminal input (bubbling to the
    // document) but does NOT fire window 'blur' or document 'focusin'. Drive exactly
    // that — only focusout, with activeElement resolving to the iframe — so the
    // reliable reclaim path is exercised instead of an event that never fires for real.
    const inputFocus = vi.spyOn(input, 'focus');
    const activeGet = vi.spyOn(document, 'activeElement', 'get').mockReturnValue(iframe);
    input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    activeGet.mockRestore();

    expect(inputFocus).toHaveBeenCalled();
    expect(onReady).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('reclaims focus via the lifetime poll for a steal after the one-shot timers are exhausted (REQ-VAULT-020 AC3)', () => {
    const onReady = vi.fn();
    const onError = vi.fn();
    const input = document.createElement('textarea');
    input.className = 'xterm-helper-textarea';
    document.body.append(input);
    input.focus();

    startVaultPrewarm({ sessionId: 'sess1234', prewarmId: 'warm-1', onReady, onError });
    const iframe = currentIframe();
    if (!iframe) throw new Error('prewarm iframe missing');

    // Let all one-shot restore timers ([0,50,250,1000]ms) elapse as no-ops while focus
    // is fine. SilverBullet's space sync / index build re-grabs focus seconds later —
    // long after those timers are gone — which is the window the old code never covered
    // (and which surfaces no parent 'blur'/'focusin'). Only the lifetime poll catches it.
    vi.advanceTimersByTime(1100);
    const inputFocus = vi.spyOn(input, 'focus');
    const activeGet = vi.spyOn(document, 'activeElement', 'get').mockReturnValue(iframe);
    vi.advanceTimersByTime(FOCUS_RECLAIM_POLL_MS);
    activeGet.mockRestore();

    expect(inputFocus).toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('stops focusout + poll focus reclaim after teardown', () => {
    const onReady = vi.fn();
    const onError = vi.fn();
    const input = document.createElement('textarea');
    input.className = 'xterm-helper-textarea';
    document.body.append(input);
    input.focus();

    const handle = startVaultPrewarm({ sessionId: 'sess1234', prewarmId: 'warm-1', onReady, onError });
    const iframe = currentIframe();
    if (!iframe) throw new Error('prewarm iframe missing');
    handle?.cancel();

    // With prewarm torn down, neither the reliable focusout path nor the lifetime poll
    // may resurrect a restore — even if we fake the (now-removed) iframe being active.
    const inputFocus = vi.spyOn(input, 'focus');
    const activeGet = vi.spyOn(document, 'activeElement', 'get').mockReturnValue(iframe);
    document.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
    vi.advanceTimersByTime(FOCUS_RECLAIM_POLL_MS * 4);
    activeGet.mockRestore();

    expect(inputFocus).not.toHaveBeenCalled();
  });

  it('ignores ready messages from a different origin', () => {
    const onReady = vi.fn();
    const onError = vi.fn();

    startVaultPrewarm({ sessionId: 'sess1234', prewarmId: 'warm-1', onReady, onError });
    window.dispatchEvent(new MessageEvent('message', {
      origin: 'https://attacker.example',
      data: { source: VAULT_PREWARM_SOURCE, prewarmId: 'warm-1', status: 'ready', proof: readyProof },
    }));

    expect(onReady).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(currentIframe()).toBeInstanceOf(HTMLIFrameElement);
  });

  it('ignores ready messages for a different prewarm attempt', () => {
    const onReady = vi.fn();
    const onError = vi.fn();

    startVaultPrewarm({ sessionId: 'sess1234', prewarmId: 'warm-1', onReady, onError });
    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      data: { source: VAULT_PREWARM_SOURCE, prewarmId: 'other-attempt', status: 'ready', proof: readyProof },
    }));

    expect(onReady).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(currentIframe()).toBeInstanceOf(HTMLIFrameElement);
  });

  it('ignores ready messages that do not include current-browser local readiness proof', () => {
    const onReady = vi.fn();
    const onError = vi.fn();

    startVaultPrewarm({ sessionId: 'sess1234', prewarmId: 'warm-1', onReady, onError });
    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      data: { source: VAULT_PREWARM_SOURCE, prewarmId: 'warm-1', status: 'ready' },
    }));

    expect(onReady).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(currentIframe()).toBeInstanceOf(HTMLIFrameElement);
  });

  it('ignores ready messages that only prove IndexedDB/service-worker readiness without content readiness', () => {
    const onReady = vi.fn();
    const onError = vi.fn();

    startVaultPrewarm({ sessionId: 'sess1234', prewarmId: 'warm-1', onReady, onError });
    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      data: { source: VAULT_PREWARM_SOURCE, prewarmId: 'warm-1', status: 'ready', proof: localOnlyProof },
    }));

    expect(onReady).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(currentIframe()).toBeInstanceOf(HTMLIFrameElement);
  });

  it('marks the prewarm ready and removes the iframe after a valid ready message', () => {
    const onReady = vi.fn();
    const onError = vi.fn();

    startVaultPrewarm({ sessionId: 'sess1234', prewarmId: 'warm-1', onReady, onError });
    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      data: { source: VAULT_PREWARM_SOURCE, prewarmId: 'warm-1', status: 'ready', proof: readyProof },
    }));

    expect(onReady).toHaveBeenCalledWith(readyProof);
    expect(onError).not.toHaveBeenCalled();
    expect(currentIframe()).toBeNull();
  });

  it('re-asserts window focus and re-focuses the terminal AFTER detaching when removal orphaned the document (REQ-VAULT-020 AC5)', () => {
    const onReady = vi.fn();
    const onError = vi.fn();
    const input = document.createElement('textarea');
    input.className = 'xterm-helper-textarea';
    document.body.append(input);
    input.focus();

    startVaultPrewarm({ sessionId: 'sess1234', prewarmId: 'warm-1', onReady, onError });
    const iframe = currentIframe();
    if (!iframe) throw new Error('prewarm iframe missing');

    // Detaching the prewarm iframe orphans the top-level document: hasFocus() goes
    // false while the terminal textarea is still the active element. jsdom does not
    // model that orphan, so drive the precondition (hasFocus reports false). The fix
    // re-asserts window focus and re-focuses the live terminal target AFTER
    // iframe.remove() — the orphan is caused by the removal, so it can only be
    // repaired, not prevented. Order proves the repair runs post-detach.
    const order: string[] = [];
    const windowFocus = vi.spyOn(window, 'focus').mockImplementation(() => order.push('window-focus'));
    const inputFocus = vi.spyOn(input, 'focus').mockImplementation(() => order.push('refocus-terminal'));
    const realRemove = iframe.remove.bind(iframe);
    vi.spyOn(iframe, 'remove').mockImplementation(() => {
      order.push('detach-iframe');
      realRemove();
    });
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(false);

    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      data: { source: VAULT_PREWARM_SOURCE, prewarmId: 'warm-1', status: 'ready', proof: readyProof },
    }));
    hasFocus.mockRestore();

    expect(windowFocus).toHaveBeenCalled();
    expect(inputFocus).toHaveBeenCalled();
    expect(order).toEqual(['detach-iframe', 'window-focus', 'refocus-terminal']);
    expect(onReady).toHaveBeenCalledWith(readyProof);
    expect(currentIframe()).toBeNull();
  });

  it('does NOT steal focus after detaching when the window kept focus (REQ-VAULT-020 AC5)', () => {
    const onReady = vi.fn();
    const onError = vi.fn();
    const input = document.createElement('textarea');
    input.className = 'xterm-helper-textarea';
    document.body.append(input);
    input.focus();

    startVaultPrewarm({ sessionId: 'sess1234', prewarmId: 'warm-1', onReady, onError });
    const iframe = currentIframe();
    if (!iframe) throw new Error('prewarm iframe missing');

    // Removal did not orphan the document (hasFocus stays true). The reassert must be
    // inert across all of its retries so a focused terminal — or whatever the user is
    // using — is never yanked back.
    const windowFocus = vi.spyOn(window, 'focus');
    const inputFocus = vi.spyOn(input, 'focus');
    const hasFocus = vi.spyOn(document, 'hasFocus').mockReturnValue(true);

    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      data: { source: VAULT_PREWARM_SOURCE, prewarmId: 'warm-1', status: 'ready', proof: readyProof },
    }));
    vi.advanceTimersByTime(250);
    hasFocus.mockRestore();

    expect(windowFocus).not.toHaveBeenCalled();
    expect(inputFocus).not.toHaveBeenCalled();
    expect(currentIframe()).toBeNull();
  });

  it('keeps the vault unavailable when prewarm times out', () => {
    const onReady = vi.fn();
    const onError = vi.fn();

    startVaultPrewarm({ sessionId: 'sess1234', prewarmId: 'warm-1', timeoutMs: 1000, onReady, onError });
    vi.advanceTimersByTime(1000);

    expect(onReady).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('timeout', 'Vault prewarm timed out');
    expect(currentIframe()).toBeNull();
  });

  it('cancel removes the iframe and prevents later ready messages from changing state', () => {
    const onReady = vi.fn();
    const onError = vi.fn();
    const handle = startVaultPrewarm({ sessionId: 'sess1234', prewarmId: 'warm-1', onReady, onError });

    handle?.cancel();
    window.dispatchEvent(new MessageEvent('message', {
      origin: window.location.origin,
      data: { source: VAULT_PREWARM_SOURCE, prewarmId: 'warm-1', status: 'ready', proof: readyProof },
    }));

    expect(onReady).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(currentIframe()).toBeNull();
  });

  it('restores focus on a parent-window blur caused by the iframe capturing focus (cross-frame fallback)', () => {
    const onReady = vi.fn();
    const onError = vi.fn();
    const input = document.createElement('textarea');
    input.className = 'xterm-helper-textarea';
    document.body.append(input);
    input.focus();

    startVaultPrewarm({ sessionId: 'sess1234', prewarmId: 'warm-1', onReady, onError });
    const iframe = currentIframe();
    if (!iframe) throw new Error('prewarm iframe missing');

    // The window blurs because focus entered the iframe (activeElement === iframe).
    const inputFocus = vi.spyOn(input, 'focus');
    const activeGet = vi.spyOn(document, 'activeElement', 'get').mockReturnValue(iframe);
    window.dispatchEvent(new Event('blur'));
    activeGet.mockRestore();

    expect(inputFocus).toHaveBeenCalled();
  });

  it('removes all focus-guard listeners on cleanup (a later blur/focusin does not restore)', () => {
    const onReady = vi.fn();
    const onError = vi.fn();
    const input = document.createElement('textarea');
    input.className = 'xterm-helper-textarea';
    document.body.append(input);
    input.focus();

    const handle = startVaultPrewarm({ sessionId: 'sess1234', prewarmId: 'warm-1', onReady, onError });
    const iframe = currentIframe();
    if (!iframe) throw new Error('prewarm iframe missing');
    handle?.cancel();

    // With the prewarm torn down, the window-blur / focusin guards must be gone:
    // even if we fake the iframe being active, no restore should fire.
    const inputFocus = vi.spyOn(input, 'focus');
    const activeGet = vi.spyOn(document, 'activeElement', 'get').mockReturnValue(iframe);
    window.dispatchEvent(new Event('blur'));
    document.dispatchEvent(new Event('focusin'));
    activeGet.mockRestore();

    expect(inputFocus).not.toHaveBeenCalled();
  });
});
