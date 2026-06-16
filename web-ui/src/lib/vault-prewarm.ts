import type { VaultLocalReadinessResult } from './vault-local-readiness';

export const VAULT_PREWARM_QUERY = 'codeflarePrewarm';
export const VAULT_PREWARM_ID_QUERY = 'prewarmId';
export const VAULT_PREWARM_SOURCE = 'codeflare-vault-prewarm';
export const DEFAULT_VAULT_PREWARM_TIMEOUT_MS = 300_000;

export type VaultPrewarmStatus = 'idle' | 'prewarming' | 'ready' | 'timeout' | 'error';

export type VaultPrewarmProof = VaultLocalReadinessResult & {
  contentReady: true;
  spaceSyncCompleted: true;
  indexReady: true;
  requiredFiles: string[];
  listedFileCount: number;
};

export type VaultPrewarmMessage =
  | {
    source: typeof VAULT_PREWARM_SOURCE;
    prewarmId: string;
    status: 'ready';
    proof: VaultPrewarmProof;
  }
  | {
    source: typeof VAULT_PREWARM_SOURCE;
    prewarmId: string;
    status: 'error';
    message?: string;
  };

export interface VaultPrewarmOptions {
  sessionId: string;
  onReady: (proof: VaultPrewarmProof) => void;
  onError: (status: Exclude<VaultPrewarmStatus, 'idle' | 'prewarming' | 'ready'>, message: string) => void;
  timeoutMs?: number;
  prewarmId?: string;
  windowRef?: Window;
  documentRef?: Document;
  schedule?: (fn: () => void, ms: number) => unknown;
  unschedule?: (handle: unknown) => void;
}

export interface VaultPrewarmHandle {
  cancel: () => void;
  prewarmId: string;
  iframe: HTMLIFrameElement;
}

function createPrewarmId(): string {
  const randomUUID = globalThis.crypto?.randomUUID?.bind(globalThis.crypto);
  return randomUUID ? randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function buildVaultPrewarmUrl(sessionId: string, prewarmId: string): string {
  const params = new URLSearchParams({
    [VAULT_PREWARM_QUERY]: '1',
    [VAULT_PREWARM_ID_QUERY]: prewarmId,
  });
  return `/api/vault/${encodeURIComponent(sessionId)}/.codeflare-bootstrap?${params.toString()}`;
}

function isVaultPrewarmProof(value: unknown): value is VaultPrewarmProof {
  if (value == null || typeof value !== 'object') return false;
  const candidate = value as Partial<VaultPrewarmProof>;
  return candidate.ready === true
    && Array.isArray(candidate.recordedDbs)
    && typeof candidate.hasIndexedDbDatabasesApi === 'boolean'
    && candidate.contentReady === true
    && candidate.spaceSyncCompleted === true
    && candidate.indexReady === true
    && Array.isArray(candidate.requiredFiles)
    && candidate.requiredFiles.every((entry) => typeof entry === 'string')
    && typeof candidate.listedFileCount === 'number'
    && Number.isFinite(candidate.listedFileCount)
    && candidate.listedFileCount >= candidate.requiredFiles.length;
}

function isVaultPrewarmMessage(value: unknown): value is VaultPrewarmMessage {
  if (value == null || typeof value !== 'object') return false;
  const candidate = value as Partial<VaultPrewarmMessage> & { proof?: unknown };
  if (candidate.source !== VAULT_PREWARM_SOURCE) return false;
  if (typeof candidate.prewarmId !== 'string') return false;
  if (candidate.status === 'error') return true;
  return candidate.status === 'ready' && isVaultPrewarmProof(candidate.proof);
}

export function startVaultPrewarm(opts: VaultPrewarmOptions): VaultPrewarmHandle | null {
  const windowRef = opts.windowRef ?? globalThis.window;
  const documentRef = opts.documentRef ?? globalThis.document;
  if (!windowRef || !documentRef?.body) {
    opts.onError('error', 'Browser document is unavailable');
    return null;
  }

  const schedule = opts.schedule ?? ((fn, ms) => windowRef.setTimeout(fn, ms));
  const unschedule = opts.unschedule ?? ((handle) => windowRef.clearTimeout(handle as number));
  const timeoutMs = opts.timeoutMs ?? DEFAULT_VAULT_PREWARM_TIMEOUT_MS;
  const prewarmId = opts.prewarmId ?? createPrewarmId();
  const iframe = documentRef.createElement('iframe');
  let finished = false;
  let timer: unknown = null;

  const cleanup = () => {
    windowRef.removeEventListener('message', onMessage);
    if (timer !== null) {
      unschedule(timer);
      timer = null;
    }
    iframe.remove();
  };

  const finishReady = (proof: VaultPrewarmProof) => {
    if (finished) return;
    finished = true;
    cleanup();
    opts.onReady(proof);
  };

  const finishError = (status: Exclude<VaultPrewarmStatus, 'idle' | 'prewarming' | 'ready'>, message: string) => {
    if (finished) return;
    finished = true;
    cleanup();
    opts.onError(status, message);
  };

  function onMessage(event: MessageEvent) {
    if (event.origin !== windowRef.location.origin) return;
    if (!isVaultPrewarmMessage(event.data)) return;
    if (event.data.prewarmId !== prewarmId) return;
    if (event.data.status === 'ready') {
      finishReady(event.data.proof);
      return;
    }
    finishError('error', event.data.message || 'Vault prewarm failed');
  }

  iframe.src = buildVaultPrewarmUrl(opts.sessionId, prewarmId);
  iframe.title = 'Vault prewarm';
  iframe.tabIndex = -1;
  iframe.setAttribute('aria-hidden', 'true');
  iframe.style.position = 'fixed';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  iframe.style.opacity = '0';
  iframe.style.pointerEvents = 'none';

  windowRef.addEventListener('message', onMessage);
  documentRef.body.appendChild(iframe);
  timer = schedule(() => finishError('timeout', 'Vault prewarm timed out'), timeoutMs);

  return {
    cancel: () => {
      if (finished) return;
      finished = true;
      cleanup();
    },
    prewarmId,
    iframe,
  };
}
