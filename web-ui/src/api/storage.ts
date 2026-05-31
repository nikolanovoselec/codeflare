import { z } from 'zod';
import {
  StorageListResultSchema,
  UploadResponseSchema,
  DeleteResponseSchema,
  MultipartInitResponseSchema,
  MultipartPartResponseSchema,
  MultipartCompleteResponseSchema,
  StorageStatsResponseSchema,
  RecreateGettingStartedDocsResponseSchema,
  RecreateAgentConfigsResponseSchema,
  StoragePreviewTextResponseSchema,
  StoragePreviewImageResponseSchema,
  StoragePreviewBinaryResponseSchema,
  SessionsSyncResponseSchema,
} from '../lib/schemas';
import { ApiError, baseFetch } from './fetch-helper';

const BASE_URL = '/api';

/** Backward-compatible subclass so existing catch blocks and tests that check error.name still work. */
class StorageApiError extends ApiError {
  constructor(status: number, message: string) {
    super(message, status, '');
    this.name = 'StorageApiError';
  }
}

async function storageFetch<T>(endpoint: string, options: RequestInit, schema: z.ZodType<T>): Promise<T> {
  try {
    return await baseFetch<T>(`${BASE_URL}${endpoint}`, options, {
      credentials: 'same-origin',
      schema,
    });
  } catch (err) {
    // Re-wrap as StorageApiError for backward compatibility
    if (err instanceof ApiError && !(err instanceof StorageApiError)) {
      throw new StorageApiError(err.status, err.message);
    }
    throw err;
  }
}

// Types derived from schemas
export type StorageListResult = z.infer<typeof StorageListResultSchema>;

// Browse files
export async function browseStorage(prefix?: string, continuationToken?: string): Promise<StorageListResult> {
  const params = new URLSearchParams();
  if (prefix) params.set('prefix', prefix);
  if (continuationToken) params.set('continuationToken', continuationToken);
  const query = params.toString();
  return storageFetch(`/storage/browse${query ? `?${query}` : ''}`, {}, StorageListResultSchema);
}

// Upload file (simple, <= 5MB original file size, sent as base64)
export async function uploadFile(key: string, content: string): Promise<{ key: string; size?: number }> {
  return storageFetch('/storage/upload', {
    method: 'POST',
    body: JSON.stringify({ key, content }),
  }, UploadResponseSchema);
}

// Multipart upload
export async function initiateMultipartUpload(key: string): Promise<{ uploadId: string; key: string }> {
  return storageFetch('/storage/upload/initiate', {
    method: 'POST',
    body: JSON.stringify({ key }),
  }, MultipartInitResponseSchema);
}

export async function uploadPart(key: string, uploadId: string, partNumber: number, content: string): Promise<{ etag: string }> {
  return storageFetch('/storage/upload/part', {
    method: 'POST',
    body: JSON.stringify({ key, uploadId, partNumber, content }),
  }, MultipartPartResponseSchema);
}

export async function completeMultipartUpload(key: string, uploadId: string, parts: { partNumber: number; etag: string }[]): Promise<{ key: string }> {
  return storageFetch('/storage/upload/complete', {
    method: 'POST',
    body: JSON.stringify({ key, uploadId, parts }),
  }, MultipartCompleteResponseSchema);
}

export async function abortMultipartUpload(key: string, uploadId: string): Promise<void> {
  try {
    await baseFetch(`${BASE_URL}/storage/upload/abort`, {
      method: 'POST',
      body: JSON.stringify({ key, uploadId }),
    }, { credentials: 'same-origin' });
  } catch (err) {
    if (err instanceof ApiError) {
      throw new StorageApiError(err.status, 'Failed to abort multipart upload');
    }
    throw err;
  }
}

// Delete files and/or prefixes
export async function deleteFiles(
  keys?: string[],
  prefixes?: string[]
): Promise<{ deleted: string[]; deletedPrefixes?: { prefix: string; count: number }[]; errors: { key: string; error: string }[] }> {
  const body: Record<string, unknown> = {};
  if (keys && keys.length > 0) body.keys = keys;
  if (prefixes && prefixes.length > 0) body.prefixes = prefixes;
  return storageFetch('/storage/delete', {
    method: 'POST',
    body: JSON.stringify(body),
  }, DeleteResponseSchema);
}


// Storage stats
type StorageStatsResponse = z.infer<typeof StorageStatsResponseSchema>;

export async function getStats(): Promise<StorageStatsResponse> {
  return storageFetch('/storage/stats', {}, StorageStatsResponseSchema);
}

type RecreateGettingStartedDocsResponse = z.infer<typeof RecreateGettingStartedDocsResponseSchema>;

export async function recreateGettingStartedDocs(): Promise<RecreateGettingStartedDocsResponse> {
  return storageFetch('/storage/seed/getting-started', { method: 'POST' }, RecreateGettingStartedDocsResponseSchema);
}

type RecreateAgentConfigsResponse = z.infer<typeof RecreateAgentConfigsResponseSchema>;

export async function recreateAgentConfigs(): Promise<RecreateAgentConfigsResponse> {
  return storageFetch('/storage/seed/agent-configs', { method: 'POST' }, RecreateAgentConfigsResponseSchema);
}

// Storage preview (discriminated union)
const StoragePreviewResponseSchema = z.discriminatedUnion('type', [
  StoragePreviewTextResponseSchema,
  StoragePreviewImageResponseSchema,
  StoragePreviewBinaryResponseSchema,
]);

export type StoragePreviewResponse = z.infer<typeof StoragePreviewResponseSchema>;

export async function getPreview(key: string): Promise<StoragePreviewResponse> {
  const params = new URLSearchParams();
  params.set('key', key);
  return storageFetch(`/storage/preview?${params.toString()}`, {}, StoragePreviewResponseSchema);
}

// Download URL (no fetch, just constructs the URL)
export function getDownloadUrl(key: string): string {
  const params = new URLSearchParams();
  params.set('key', key);
  return `${BASE_URL}/storage/download?${params.toString()}`;
}

// Sync-now fan-out (REQ-STOR-015 AC1). Calls POST /api/sessions/sync
// which enumerates the user's running sessions and triggers a bisync
// on each. Returns per-session result; the UI uses these to show
// "Triggered N sessions" feedback and re-list R2 after a brief delay.
type SessionsSyncResponse = z.infer<typeof SessionsSyncResponseSchema>;
export async function syncAllSessions(): Promise<SessionsSyncResponse> {
  return storageFetch('/sessions/sync', { method: 'POST' }, SessionsSyncResponseSchema);
}
