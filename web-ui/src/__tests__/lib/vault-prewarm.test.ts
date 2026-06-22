import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildVaultPrewarmUrl,
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

describe('REQ-MOB-014 / REQ-VAULT-020: vault browser prewarm protocol', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
  });

  afterEach(() => {
    vi.useRealTimers();
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
