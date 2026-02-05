import { z } from 'zod';
import {
  StorageListResultSchema,
  UploadResponseSchema,
  DeleteResponseSchema,
  MoveResponseSchema,
  MultipartInitResponseSchema,
  MultipartPartResponseSchema,
  MultipartCompleteResponseSchema,
  StorageStatsResponseSchema,
  RecreateGettingStartedDocsResponseSchema,
  StoragePreviewTextResponseSchema,
  StoragePreviewImageResponseSchema,
  StoragePreviewBinaryResponseSchema,
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

// Upload file (simple, <= 5MB base64)
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

// Delete files
export async function deleteFiles(keys: string[]): Promise<{ deleted: string[]; errors: { key: string; error: string }[] }> {
  return storageFetch('/storage/delete', {
    method: 'POST',
    body: JSON.stringify({ keys }),
  }, DeleteResponseSchema);
}

// Move/rename file
export async function moveFile(source: string, destination: string): Promise<{ source: string; destination: string; warning?: string }> {
  return storageFetch('/storage/move', {
    method: 'POST',
    body: JSON.stringify({ source, destination }),
  }, MoveResponseSchema);
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
