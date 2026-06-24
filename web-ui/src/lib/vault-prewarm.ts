import type { VaultLocalReadinessResult } from './vault-local-readiness';

export const VAULT_PREWARM_QUERY = 'codeflarePrewarm';
export const VAULT_PREWARM_ID_QUERY = 'prewarmId';
export const VAULT_PREWARM_SOURCE = 'codeflare-vault-prewarm';
export const DEFAULT_VAULT_PREWARM_TIMEOUT_MS = 300_000;
// Cadence for the parent-side focus-reclaim poll. This is the reliable backstop:
// when focus moves into a SAME-ORIGIN child iframe the document never fires
// `focusin`, and window `blur` is unreliable (it fires in some Chromium builds /
// headless but not on desktop Chrome, where the tab keeps focus), so the event
// listeners alone can miss a steal. Polling guarantees focus can never stay
// trapped in the iframe.
export const FOCUS_RECLAIM_POLL_MS = 250;

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

function getRestorableFocus(documentRef: Document): HTMLElement | null {
  const active = documentRef.activeElement;
  if (!active || active === documentRef.body || active === documentRef.documentElement) return null;
  if (typeof (active as HTMLElement).focus !== 'function') return null;
  return active as HTMLElement;
}

function restoreFocusIfPrewarmCaptured(
  documentRef: Document,
  iframe: HTMLIFrameElement,
  previousFocus: HTMLElement | null,
): void {
  if (!previousFocus || !previousFocus.isConnected) return;
  if (documentRef.activeElement !== iframe) return;
  previousFocus.focus({ preventScroll: true });
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
  // The element to restore focus to is tracked LIVE, not snapshotted at start:
  // prewarm begins when the vault goes ready (background), typically before the
  // user enters the terminal, so a start-time snapshot would aim restore at a
  // stale dashboard element. The focusin listener keeps this pointed at whatever
  // the user is actually using (e.g. the xterm textarea) when SilverBullet inside
  // the iframe grabs focus late.
  let lastGoodFocus = getRestorableFocus(documentRef);
  const focusRestoreTimers: unknown[] = [];
  let finished = false;
  let timer: unknown = null;
  let focusPollHandle: unknown = null;

  const restoreFocus = () => restoreFocusIfPrewarmCaptured(documentRef, iframe, lastGoodFocus);

  // Single guard for the whole prewarm lifetime: if the iframe captured focus,
  // hand it straight back; otherwise remember the live focus as the restore target.
  const onFocusIn = () => {
    if (documentRef.activeElement === iframe) {
      restoreFocus();
      return;
    }
    const restorable = getRestorableFocus(documentRef);
    if (restorable && restorable !== iframe) lastGoodFocus = restorable;
  };

  // The RELIABLE steal signal. When SilverBullet calls element.focus() inside the
  // same-origin prewarm iframe, focus leaves the terminal input and the browser
  // fires `focusout` on it (bubbling to the document) — the one event guaranteed to
  // fire. Document `focusin` never fires (no parent element gains focus) and window
  // `blur` is unreliable across browsers, so `focusout` is what actually catches the
  // steal, the instant it happens. (Verified in Chrome: focus into a same-origin
  // iframe yields activeElement === iframe and a focusout on the prior element.)
  const onFocusOut = () => {
    if (documentRef.activeElement === iframe) restoreFocus();
  };

  // Lifetime backstop for steals that surface no parent-observable event at all
  // (focus already inside the frame before listeners attached, late re-grabs after
  // the one-shot timers below have elapsed). The check is a no-op whenever the
  // iframe is not the active element, so it never fights a focused terminal.
  const pollFocusReclaim = () => {
    if (finished) return;
    restoreFocus();
    focusPollHandle = schedule(pollFocusReclaim, FOCUS_RECLAIM_POLL_MS);
  };

  const cleanup = () => {
    windowRef.removeEventListener('message', onMessage);
    windowRef.removeEventListener('blur', restoreFocus);
    documentRef.removeEventListener('focusin', onFocusIn);
    documentRef.removeEventListener('focusout', onFocusOut);
    iframe.removeEventListener('focus', restoreFocus);
    iframe.removeEventListener('load', restoreFocus);
    if (timer !== null) {
      unschedule(timer);
      timer = null;
    }
    if (focusPollHandle !== null) {
      unschedule(focusPollHandle);
      focusPollHandle = null;
    }
    while (focusRestoreTimers.length > 0) {
      const focusTimer = focusRestoreTimers.pop();
      if (focusTimer !== undefined) unschedule(focusTimer);
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
  iframe.setAttribute('inert', '');
  iframe.style.position = 'fixed';
  iframe.style.width = '0';
  iframe.style.height = '0';
  iframe.style.border = '0';
  iframe.style.opacity = '0';
  iframe.style.pointerEvents = 'none';

  windowRef.addEventListener('message', onMessage);
  // Secondary signal only. Window `blur` on a focus move into a SAME-ORIGIN child
  // iframe is unreliable — it fires in some Chromium builds / headless but not on
  // desktop Chrome (the tab keeps system focus; document.hasFocus() stays true) —
  // which is why the eager prewarm could trap terminal focus despite this listener.
  // The reliable catches are `focusout` and the lifetime poll below; we keep this
  // for the cases where it does fire, and restoreFocus only acts when
  // activeElement === iframe, so it is otherwise inert.
  windowRef.addEventListener('blur', restoreFocus);
  documentRef.addEventListener('focusin', onFocusIn);
  documentRef.addEventListener('focusout', onFocusOut);
  iframe.addEventListener('focus', restoreFocus);
  iframe.addEventListener('load', restoreFocus);
  documentRef.body.appendChild(iframe);
  restoreFocus();
  for (const delayMs of [0, 50, 250, 1000]) {
    focusRestoreTimers.push(schedule(restoreFocus, delayMs));
  }
  focusPollHandle = schedule(pollFocusReclaim, FOCUS_RECLAIM_POLL_MS);
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
