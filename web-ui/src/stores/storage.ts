import { createStore, produce } from 'solid-js/store';
import * as storageApi from '../api/storage';
import { getStartupStatus } from '../api/client';
import { shouldUseMultipart, splitIntoParts, fileToBase64 } from '../lib/file-upload';
import { STORAGE_BROWSE_RETRY_DELAY_MS, UPLOAD_DISMISS_DELAY_MS } from '../lib/constants';
import type { FileWithPath } from '../lib/file-upload';

interface StorageObject {
  key: string;
  size: number;
  lastModified: string;
  etag?: string;
}

interface UploadItem {
  id: string;
  fileName: string;
  relativePath: string;
  progress: number;
  status: 'pending' | 'uploading' | 'complete' | 'error';
  error?: string;
}

interface StorageStats {
  totalFiles: number;
  totalFolders: number;
  totalSizeBytes: number;
  bucketName?: string;
  maxStorageBytes?: number | null;
}

interface PreviewFile {
  key: string;
  type: 'text' | 'image' | 'binary';
  content?: string;
  url?: string;
  size: number;
  lastModified: string;
}

interface SyncNowResult {
  triggered: number;
  notRunning: number;
  failed: number;
  total: number;
  lastError?: string;
}

interface StorageState {
  currentPrefix: string;
  objects: StorageObject[];
  prefixes: string[];
  loading: boolean;
  error: string | null;
  uploads: UploadItem[];
  selectedKeys: string[];
  selectedPrefixes: string[];
  isTruncated: boolean;
  nextContinuationToken: string | null;
  stats: StorageStats | null;
  previewFile: PreviewFile | null;
  backgroundRefreshing: boolean;
  workerName: string;
  // REQ-STOR-015: sync-now flag drives the toolbar button's disabled
  // state and spinner overlay. The last result is held briefly so the
  // toolbar can surface "Triggered N sessions" feedback.
  syncing: boolean;
  syncResult: SyncNowResult | null;
}

const initialState: StorageState = {
  currentPrefix: '',
  objects: [],
  prefixes: [],
  loading: false,
  error: null,
  uploads: [],
  selectedKeys: [],
  selectedPrefixes: [],
  isTruncated: false,
  nextContinuationToken: null,
  stats: null,
  previewFile: null,
  backgroundRefreshing: false,
  workerName: 'codeflare',
  syncing: false,
  syncResult: null,
};

// REQ-STOR-015 AC6: how long to keep the syncResult visible after the
// fan-out request returns. Long enough for the user to read the toast,
// short enough that stale state does not linger.
const SYNC_RESULT_DISPLAY_MS = 4000;

// Module-scoped timer for the auto-clear of syncResult after a sync
// completes. Tracked so a rapid-fire second syncNow() can cancel the
// first pending clear before it wipes the new result mid-display.
// Declared before its consumer (syncNow.finally) so lint rules
// `no-use-before-define` are satisfied and any future synchronous-init
// caller cannot trip TDZ.
let syncResultClearTimer: number | null = null;

// REQ-STOR-015 AC6: after fan-out triggers SIGUSR1 on each daemon, poll
// /api/container/startup-status until every triggered session has left
// the 'syncing' state, so the breathing animation reflects the actual
// underlying bisync rather than just the brief fan-out HTTP call.
const SYNC_POLL_INTERVAL_MS = 2000;
// Cap polling at the DO destroy budget (REQ-STOR-005). A bisync that
// runs longer than that would be killed by the SDK anyway.
const SYNC_POLL_TIMEOUT_MS = 135_000;
// If we never observed any session transition into 'syncing', give up
// after this grace window -- the bisync may have completed faster than
// our 2s poll could catch, or the trigger was lost.
const SYNC_POLL_SETTLE_MS = 4000;

async function pollSessionSyncCompletion(sessionIds: string[]): Promise<void> {
  if (sessionIds.length === 0) return;
  const start = Date.now();
  const sawSyncing = new Set<string>();
  // Track consecutive probe failures per session so a transient network
  // outage doesn't silently mask every session as "complete". After
  // PROBE_ERROR_THRESHOLD consecutive errors for a given session the
  // poll surfaces the network failure in syncResult.lastError instead
  // of pretending everything finished cleanly.
  const PROBE_ERROR_THRESHOLD = 3;
  const consecutiveProbeErrors = new Map<string, number>();
  while (Date.now() - start < SYNC_POLL_TIMEOUT_MS) {
    const results = await Promise.all(
      sessionIds.map(async (id) => {
        try {
          const status = await getStartupStatus(id);
          consecutiveProbeErrors.set(id, 0);
          return { id, syncStatus: status.details?.syncStatus, probeError: false };
        } catch {
          const n = (consecutiveProbeErrors.get(id) ?? 0) + 1;
          consecutiveProbeErrors.set(id, n);
          return { id, syncStatus: 'success' as const, probeError: true };
        }
      })
    );
    for (const r of results) {
      if (r.syncStatus === 'syncing') sawSyncing.add(r.id);
    }
    const stillSyncing = results.some((r) => r.syncStatus === 'syncing');
    // If every session has hit the probe-error threshold the network is
    // genuinely down -- surface it so the user knows the spinner stopped
    // due to inability to verify, not actual completion.
    const allProbeFailing = sessionIds.every(
      (id) => (consecutiveProbeErrors.get(id) ?? 0) >= PROBE_ERROR_THRESHOLD
    );
    if (allProbeFailing) {
      setState('syncResult', (prev) =>
        prev ? { ...prev, lastError: 'Unable to verify sync completion (network error).' } : prev
      );
      return;
    }
    if (stillSyncing) {
      await new Promise((res) => setTimeout(res, SYNC_POLL_INTERVAL_MS));
      continue;
    }
    // No session is currently syncing. We're done if we already saw
    // every triggered session transition through 'syncing' OR if the
    // grace window has elapsed (bisync may have finished too fast to
    // catch, or the daemon never received the signal).
    if (sawSyncing.size === sessionIds.length || Date.now() - start > SYNC_POLL_SETTLE_MS) {
      return;
    }
    await new Promise((res) => setTimeout(res, SYNC_POLL_INTERVAL_MS));
  }
}

const [state, setState] = createStore<StorageState>({ ...initialState });

export const storageStore = {
  get objects() { return state.objects; },
  get prefixes() { return state.prefixes; },
  get currentPrefix() { return state.currentPrefix; },
  get loading() { return state.loading; },
  get error() { return state.error; },
  get uploads() { return state.uploads; },
  get selectedKeys() { return state.selectedKeys; },
  get selectedPrefixes() { return state.selectedPrefixes; },
  get isTruncated() { return state.isTruncated; },
  get nextContinuationToken() { return state.nextContinuationToken; },
  get stats() { return state.stats; },
  get previewFile() { return state.previewFile; },
  get backgroundRefreshing() { return state.backgroundRefreshing; },
  get workerName() { return state.workerName; },
  setWorkerName(name: string) { setState('workerName', name); },
  get syncing() { return state.syncing; },
  get syncResult() { return state.syncResult; },
  get breadcrumbs() {
    const parts = state.currentPrefix.split('/').filter(Boolean);
    return parts.map((_, i) => parts.slice(0, i + 1).join('/') + '/');
  },

  async browse(prefix?: string, options?: { silent?: boolean }) {
    const browsePrefix = prefix ?? state.currentPrefix;
    const silent = options?.silent ?? false;

    setState('currentPrefix', browsePrefix);
    if (silent) {
      setState('backgroundRefreshing', true);
    } else {
      setState('loading', true);
    }
    setState('error', null);

    const applyResult = (result: Awaited<ReturnType<typeof storageApi.browseStorage>>) => {
      setState(produce((s) => {
        s.objects = result.objects.filter((o) => o.key !== browsePrefix);
        s.prefixes = result.prefixes;
        s.isTruncated = result.isTruncated;
        s.nextContinuationToken = result.nextContinuationToken ?? null;
        s.loading = false;
        s.backgroundRefreshing = false;
      }));
    };

    try {
      applyResult(await storageApi.browseStorage(browsePrefix));
    } catch {
      // Auto-retry once after delay (handles post-setup bucket creation / secret propagation)
      try {
        await new Promise((r) => setTimeout(r, STORAGE_BROWSE_RETRY_DELAY_MS));
        applyResult(await storageApi.browseStorage(browsePrefix));
      } catch (retryErr) {
        setState(produce((s) => {
          s.error = retryErr instanceof Error ? retryErr.message : String(retryErr);
          s.loading = false;
          s.backgroundRefreshing = false;
        }));
      }
    }
  },

  async navigateTo(prefix: string) {
    setState('currentPrefix', prefix);
    setState('selectedKeys', []);
    setState('selectedPrefixes', []);
    await storageStore.browse(prefix);
  },

  async navigateUp() {
    const parts = state.currentPrefix.split('/').filter(Boolean);
    if (parts.length === 0) return;  // Only stop when already at root ''
    const parentPrefix = parts.length === 1 ? '' : parts.slice(0, -1).join('/') + '/';
    await storageStore.navigateTo(parentPrefix);
  },

  async createFolder(name: string) {
    const key = state.currentPrefix + name.replace(/\/+$/, '') + '/';
    try {
      await storageApi.uploadFile(key, '');
      await storageStore.refresh();
    } catch (e) {
      setState('error', e instanceof Error ? e.message : 'Failed to create folder');
    }
  },

  async uploadFiles(files: FileWithPath[], destPrefix: string) {
    const uploadItems: UploadItem[] = files.map((f, i) => ({
      id: `upload-${Date.now()}-${i}`,
      fileName: f.file.name,
      relativePath: f.relativePath,
      progress: 0,
      status: 'pending' as const,
    }));

    setState(produce((s) => {
      s.uploads.push(...uploadItems);
    }));

    for (let i = 0; i < files.length; i++) {
      const fileWithPath = files[i];
      const uploadId = uploadItems[i].id;
      const key = destPrefix + fileWithPath.relativePath;

      setState(produce((s) => {
        const item = s.uploads.find((u) => u.id === uploadId);
        if (item) item.status = 'uploading';
      }));

      let multipartKey: string | undefined;
      let multipartUploadId: string | undefined;
      try {
        if (shouldUseMultipart(fileWithPath.file)) {
          const initResult = await storageApi.initiateMultipartUpload(key);
          multipartKey = initResult.key;
          multipartUploadId = initResult.uploadId;
          const parts = splitIntoParts(fileWithPath.file);
          const completedParts: { partNumber: number; etag: string }[] = [];

          for (let p = 0; p < parts.length; p++) {
            const content = await fileToBase64(new File([parts[p]], fileWithPath.file.name));
            const partResult = await storageApi.uploadPart(key, initResult.uploadId, p + 1, content);
            completedParts.push({ partNumber: p + 1, etag: partResult.etag });

            setState(produce((s) => {
              const item = s.uploads.find((u) => u.id === uploadId);
              if (item) item.progress = Math.round(((p + 1) / parts.length) * 100);
            }));
          }

          await storageApi.completeMultipartUpload(key, initResult.uploadId, completedParts);
        } else {
          const content = await fileToBase64(fileWithPath.file);
          await storageApi.uploadFile(key, content);
        }

        setState(produce((s) => {
          const item = s.uploads.find((u) => u.id === uploadId);
          if (item) {
            item.status = 'complete';
            item.progress = 100;
          }
        }));

        // Auto-dismiss completed upload
        setTimeout(() => {
          setState(produce((s) => {
            const idx = s.uploads.findIndex((u) => u.id === uploadId);
            if (idx !== -1) s.uploads.splice(idx, 1);
          }));
        }, UPLOAD_DISMISS_DELAY_MS);
      } catch (err) {
        // Abort incomplete multipart upload to avoid orphaned parts
        if (multipartKey && multipartUploadId) {
          storageApi.abortMultipartUpload(multipartKey, multipartUploadId).catch(() => {});
        }
        setState(produce((s) => {
          const item = s.uploads.find((u) => u.id === uploadId);
          if (item) {
            item.status = 'error';
            item.error = err instanceof Error ? err.message : String(err);
          }
        }));
      }
    }

    await storageStore.browse();
  },

  async deleteSelected() {
    if (state.selectedKeys.length === 0 && state.selectedPrefixes.length === 0) return;
    try {
      const keys = state.selectedKeys.length > 0 ? [...state.selectedKeys] : undefined;
      const prefixes = state.selectedPrefixes.length > 0 ? [...state.selectedPrefixes] : undefined;
      await storageApi.deleteFiles(keys, prefixes);
      setState('selectedKeys', []);
      setState('selectedPrefixes', []);
      await storageStore.browse();
    } catch (err) {
      setState('error', err instanceof Error ? err.message : String(err));
    }
  },


  toggleSelect(key: string) {
    setState(produce((s) => {
      const idx = s.selectedKeys.indexOf(key);
      if (idx >= 0) {
        s.selectedKeys.splice(idx, 1);
      } else {
        s.selectedKeys.push(key);
      }
    }));
  },

  toggleSelectPrefix(prefix: string) {
    setState(produce((s) => {
      const idx = s.selectedPrefixes.indexOf(prefix);
      if (idx >= 0) {
        s.selectedPrefixes.splice(idx, 1);
      } else {
        s.selectedPrefixes.push(prefix);
      }
    }));
  },

  setSelection(keys: string[], prefixes: string[]) {
    setState('selectedKeys', keys);
    setState('selectedPrefixes', prefixes);
  },

  selectAll() {
    setState('selectedKeys', state.objects.map((o) => o.key));
    setState('selectedPrefixes', state.prefixes.slice());
  },

  clearSelection() {
    setState('selectedKeys', []);
    setState('selectedPrefixes', []);
  },

  async fetchStats() {
    try {
      const stats = await storageApi.getStats();
      setState('stats', stats);
    } catch (err) {
      setState('error', err instanceof Error ? err.message : String(err));
    }
  },

  async openPreview(key: string) {
    try {
      const preview = await storageApi.getPreview(key);
      const previewFile: PreviewFile = {
        key,
        type: preview.type,
        size: preview.size,
        lastModified: preview.lastModified,
        ...(preview.type === 'text' ? { content: preview.content } : {}),
        ...(preview.type === 'image' ? { url: preview.url } : {}),
      };
      setState('previewFile', previewFile);
    } catch (err) {
      setState('error', err instanceof Error ? err.message : String(err));
    }
  },

  closePreview() {
    setState('previewFile', null);
  },

  searchFiles(query: string) {
    if (!query) {
      return { objects: [...state.objects], prefixes: [...state.prefixes] };
    }
    const lowerQuery = query.toLowerCase();
    return {
      objects: state.objects.filter((o) => o.key.toLowerCase().includes(lowerQuery)),
      prefixes: state.prefixes.filter((p) => p.toLowerCase().includes(lowerQuery)),
    };
  },

  async refresh(options?: { silent?: boolean }) {
    await storageStore.browse(undefined, options);
  },

  /**
   * REQ-STOR-015: fan-out a bisync trigger to all the user's running
   * sessions, then re-list R2 once the trigger completes.
   *
   * The fan-out call itself is fast (it triggers SIGUSR1 per session
   * and returns). The actual bisync runs in each container's daemon
   * AFTER the trigger returns, so we re-list R2 after a short delay
   * to give the bisyncs a chance to propagate fresh content before
   * the user sees the new listing.
   *
   * Hibernation-resilient: the response shape includes `not-running`
   * for sleeping containers. The aggregate counters distinguish
   * triggered / not-running / failed so the user gets honest feedback.
   */
  async syncNow() {
    if (state.syncing) return;  // idempotent click guard
    setState('syncing', true);
    setState('syncResult', null);
    try {
      const result = await storageApi.syncAllSessions();
      const aggregate: SyncNowResult = {
        triggered: result.sessions.filter((s) => s.status === 'triggered').length,
        notRunning: result.sessions.filter((s) => s.status === 'not-running').length,
        failed: result.sessions.filter((s) => s.status === 'failed').length,
        total: result.count,
        lastError: result.sessions.find((s) => s.status === 'failed')?.error,
      };
      setState('syncResult', aggregate);

      // Poll each triggered session's bisync state until none report
      // 'syncing'. Without this the breathing animation only lasts the
      // ~1s of the fan-out HTTP call -- the user would not see a
      // visual cue while the actual bisync (10-90s) runs.
      const triggeredIds = result.sessions
        .filter((s) => s.status === 'triggered')
        .map((s) => s.sessionId);
      await pollSessionSyncCompletion(triggeredIds);

      // Re-list R2 so the user sees the freshest state. Silent to
      // avoid a loading spinner on top of the breathing icon.
      await storageStore.refresh({ silent: true });
    } catch (err) {
      setState('syncResult', {
        triggered: 0,
        notRunning: 0,
        failed: 0,
        total: 0,
        lastError: err instanceof Error ? err.message : String(err),
      });
    } finally {
      setState('syncing', false);
      // Auto-clear the result message after a brief display window.
      // Track the timer so a rapid-fire second syncNow() cancels the
      // first pending clear (otherwise the previous result wipes the
      // new one mid-display). Module-scoped — there is only ever one
      // sync result visible at a time.
      if (syncResultClearTimer !== null) clearTimeout(syncResultClearTimer);
      syncResultClearTimer = setTimeout(() => {
        syncResultClearTimer = null;
        setState((s) => (s.syncing ? s : { ...s, syncResult: null }));
      }, SYNC_RESULT_DISPLAY_MS) as unknown as number;
    }
  },
};

/** Update stats from batch-status polling. Preserves maxStorageBytes and bucketName
 *  from the last fetchStats() call — batch-status doesn't include quota info. */
export function updateStatsFromBatch(stats: { totalFiles: number; totalFolders: number; totalSizeBytes: number }): void {
  setState('stats', (prev) => ({
    ...prev,
    ...stats,
  }));
}

/** @internal test-only */
export function _resetForTests() {
  setState(produce((s) => {
    Object.assign(s, { ...initialState, selectedKeys: [], selectedPrefixes: [], uploads: [], backgroundRefreshing: false });
  }));
}
