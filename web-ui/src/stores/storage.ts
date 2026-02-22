import { createStore, produce } from 'solid-js/store';
import * as storageApi from '../api/storage';
import type { StoragePreviewResponse } from '../api/storage';
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
}

interface PreviewFile {
  key: string;
  type: 'text' | 'image' | 'binary';
  content?: string;
  url?: string;
  size: number;
  lastModified: string;
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
}

const initialState: StorageState = {
  currentPrefix: 'workspace/',
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
};

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
      const keysToDelete = [...state.selectedKeys];
      if (state.selectedPrefixes.length > 0) {
        const prefixKeys = await storageStore.collectKeysForPrefixes(state.selectedPrefixes);
        keysToDelete.push(...prefixKeys);
      }
      if (keysToDelete.length > 0) {
        const batches: string[][] = [];
        for (let i = 0; i < keysToDelete.length; i += 1000) {
          batches.push(keysToDelete.slice(i, i + 1000));
        }
        for (const batch of batches) {
          await storageApi.deleteFiles(batch);
        }
      }
      setState('selectedKeys', []);
      setState('selectedPrefixes', []);
      await storageStore.browse();
    } catch (err) {
      setState('error', err instanceof Error ? err.message : String(err));
    }
  },

  async moveFile(source: string, destination: string) {
    try {
      await storageApi.moveFile(source, destination);
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

  async collectKeysForPrefixes(prefixes: string[]): Promise<string[]> {
    const keys: string[] = [];
    const visited = new Set<string>();

    const collectRecursive = async (prefix: string) => {
      if (visited.has(prefix)) return;
      visited.add(prefix);
      let continuationToken: string | undefined;
      do {
        const result = await storageApi.browseStorage(prefix, continuationToken);
        keys.push(...result.objects.map((o) => o.key));
        for (const subPrefix of result.prefixes) {
          await collectRecursive(subPrefix);
        }
        continuationToken = result.nextContinuationToken ?? undefined;
      } while (continuationToken);
    };

    for (const prefix of prefixes) {
      await collectRecursive(prefix);
    }
    return keys;
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
};

/** @internal test-only */
export function _resetForTests() {
  setState(produce((s) => {
    Object.assign(s, { ...initialState, selectedKeys: [], selectedPrefixes: [], uploads: [], backgroundRefreshing: false });
  }));
}
