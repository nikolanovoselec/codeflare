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

describe('vault browser prewarm protocol', () => {
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
    expect(iframe?.tabIndex).toBe(-1);
    const url = new URL(iframe?.src ?? '', window.location.origin);
    expect(url.pathname).toBe('/api/vault/sess1234/.codeflare-bootstrap');
    expect(url.searchParams.get(VAULT_PREWARM_ID_QUERY)).toBe('warm-1');
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
});
