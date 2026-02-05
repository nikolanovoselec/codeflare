import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createMockFetchResponse as mockResponse,
  createMockErrorResponse as mockErrorResponse,
} from '../helpers/mock-factories';

// Must mock before imports
const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

import {
  browseStorage,
  uploadFile,
  deleteFiles,
  moveFile,
  initiateMultipartUpload,
  uploadPart,
  completeMultipartUpload,
  abortMultipartUpload,
  getStats,
  recreateGettingStartedDocs,
  getPreview,
  getDownloadUrl,
} from '../../api/storage';

beforeEach(() => {
  mockFetch.mockReset();
});

describe('Storage API Client', () => {
  // ==========================================================================
  // browseStorage
  // ==========================================================================
  describe('browseStorage', () => {
    it('calls correct URL with no params', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          objects: [],
          prefixes: [],
          isTruncated: false,
        })
      );

      await browseStorage();

      expect(mockFetch).toHaveBeenCalledWith('/api/storage/browse', expect.objectContaining({}));
    });

    it('passes prefix and continuationToken as query params', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          objects: [],
          prefixes: [],
          isTruncated: false,
        })
      );

      await browseStorage('documents/', 'token123');

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/storage/browse?prefix=documents%2F&continuationToken=token123',
        expect.objectContaining({})
      );
    });

    it('returns parsed StorageListResult', async () => {
      const responseBody = {
        objects: [
          { key: 'file.txt', size: 1024, lastModified: '2025-01-01T00:00:00Z', etag: '"abc"' },
        ],
        prefixes: ['folder/'],
        isTruncated: true,
        nextContinuationToken: 'next-token',
      };
      mockFetch.mockResolvedValueOnce(mockResponse(responseBody));

      const result = await browseStorage();

      expect(result).toEqual(responseBody);
      expect(result.objects).toHaveLength(1);
      expect(result.objects[0].key).toBe('file.txt');
      expect(result.prefixes).toEqual(['folder/']);
      expect(result.isTruncated).toBe(true);
      expect(result.nextContinuationToken).toBe('next-token');
    });
  });

  // ==========================================================================
  // uploadFile
  // ==========================================================================
  describe('uploadFile', () => {
    it('sends POST with key and content', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ key: 'test.txt', size: 100 })
      );

      await uploadFile('test.txt', 'base64content');

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/storage/upload',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ key: 'test.txt', content: 'base64content' }),
        })
      );
    });

    it('returns key and size', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ key: 'test.txt', size: 256 })
      );

      const result = await uploadFile('test.txt', 'base64content');

      expect(result.key).toBe('test.txt');
      expect(result.size).toBe(256);
    });
  });

  // ==========================================================================
  // deleteFiles
  // ==========================================================================
  describe('deleteFiles', () => {
    it('sends POST with keys array', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ deleted: ['a.txt', 'b.txt'], errors: [] })
      );

      await deleteFiles(['a.txt', 'b.txt']);

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/storage/delete',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ keys: ['a.txt', 'b.txt'] }),
        })
      );
    });

    it('returns deleted and errors arrays', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          deleted: ['a.txt'],
          errors: [{ key: 'b.txt', error: 'Not found' }],
        })
      );

      const result = await deleteFiles(['a.txt', 'b.txt']);

      expect(result.deleted).toEqual(['a.txt']);
      expect(result.errors).toEqual([{ key: 'b.txt', error: 'Not found' }]);
    });
  });

  // ==========================================================================
  // moveFile
  // ==========================================================================
  describe('moveFile', () => {
    it('sends POST with source and destination', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ source: 'old.txt', destination: 'new.txt' })
      );

      await moveFile('old.txt', 'new.txt');

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/storage/move',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ source: 'old.txt', destination: 'new.txt' }),
        })
      );
    });

    it('returns source, destination, and optional warning', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          source: 'old.txt',
          destination: 'new.txt',
          warning: 'File overwritten',
        })
      );

      const result = await moveFile('old.txt', 'new.txt');

      expect(result.source).toBe('old.txt');
      expect(result.destination).toBe('new.txt');
      expect(result.warning).toBe('File overwritten');
    });
  });

  // ==========================================================================
  // Multipart upload
  // ==========================================================================
  describe('initiateMultipartUpload', () => {
    it('returns uploadId and key', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ uploadId: 'upload-123', key: 'large-file.bin' })
      );

      const result = await initiateMultipartUpload('large-file.bin');

      expect(result.uploadId).toBe('upload-123');
      expect(result.key).toBe('large-file.bin');
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/storage/upload/initiate',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ key: 'large-file.bin' }),
        })
      );
    });
  });

  describe('uploadPart', () => {
    it('returns etag', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ etag: '"part-etag-1"' })
      );

      const result = await uploadPart('large-file.bin', 'upload-123', 1, 'partContent');

      expect(result.etag).toBe('"part-etag-1"');
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/storage/upload/part',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            key: 'large-file.bin',
            uploadId: 'upload-123',
            partNumber: 1,
            content: 'partContent',
          }),
        })
      );
    });
  });

  describe('completeMultipartUpload', () => {
    it('returns key', async () => {
      const parts = [
        { partNumber: 1, etag: '"etag1"' },
        { partNumber: 2, etag: '"etag2"' },
      ];
      mockFetch.mockResolvedValueOnce(
        mockResponse({ key: 'large-file.bin' })
      );

      const result = await completeMultipartUpload('large-file.bin', 'upload-123', parts);

      expect(result.key).toBe('large-file.bin');
      expect(mockFetch).toHaveBeenCalledWith(
        '/api/storage/upload/complete',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({
            key: 'large-file.bin',
            uploadId: 'upload-123',
            parts,
          }),
        })
      );
    });
  });

  describe('abortMultipartUpload', () => {
    it('succeeds with no return value', async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 204 }));

      await expect(abortMultipartUpload('large-file.bin', 'upload-123')).resolves.toBeUndefined();

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/storage/upload/abort',
        expect.objectContaining({
          method: 'POST',
          body: JSON.stringify({ key: 'large-file.bin', uploadId: 'upload-123' }),
        })
      );
    });

    it('throws StorageApiError on failure', async () => {
      mockFetch.mockResolvedValueOnce(new Response(null, { status: 500 }));

      await expect(abortMultipartUpload('large-file.bin', 'upload-123')).rejects.toThrow(
        'Failed to abort multipart upload'
      );
    });
  });

  // ==========================================================================
  // getStats
  // ==========================================================================
  describe('getStats', () => {
    it('calls GET /api/storage/stats', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ totalFiles: 10, totalFolders: 3, totalSizeBytes: 2048 })
      );

      await getStats();

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/storage/stats',
        expect.objectContaining({})
      );
    });

    it('returns parsed StorageStatsResponse', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ totalFiles: 42, totalFolders: 5, totalSizeBytes: 1048576 })
      );

      const result = await getStats();

      expect(result.totalFiles).toBe(42);
      expect(result.totalFolders).toBe(5);
      expect(result.totalSizeBytes).toBe(1048576);
    });
  });

  // ==========================================================================
  // recreateGettingStartedDocs
  // ==========================================================================
  describe('recreateGettingStartedDocs', () => {
    it('calls POST /api/storage/seed/getting-started', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({
          success: true,
          bucketCreated: false,
          written: ['Getting-Started.md', 'Documentation/README.md'],
          skipped: [],
        })
      );

      await recreateGettingStartedDocs();

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/storage/seed/getting-started',
        expect.objectContaining({ method: 'POST' })
      );
    });
  });

  // ==========================================================================
  // getPreview
  // ==========================================================================
  describe('getPreview', () => {
    it('calls GET /api/storage/preview with encoded key', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ type: 'text', content: 'hello', size: 5, lastModified: '2025-01-01T00:00:00Z' })
      );

      await getPreview('docs/readme.md');

      expect(mockFetch).toHaveBeenCalledWith(
        '/api/storage/preview?key=docs%2Freadme.md',
        expect.objectContaining({})
      );
    });

    it('returns parsed text preview', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ type: 'text', content: 'file content', size: 12, lastModified: '2025-01-01T00:00:00Z' })
      );

      const result = await getPreview('file.txt');

      expect(result.type).toBe('text');
      if (result.type === 'text') {
        expect(result.content).toBe('file content');
      }
      expect(result.size).toBe(12);
    });

    it('returns parsed image preview', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ type: 'image', url: 'https://example.com/img.png', size: 204800, lastModified: '2025-01-01T00:00:00Z' })
      );

      const result = await getPreview('photo.png');

      expect(result.type).toBe('image');
      if (result.type === 'image') {
        expect(result.url).toBe('https://example.com/img.png');
      }
    });

    it('returns parsed binary preview', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ type: 'binary', size: 1048576, lastModified: '2025-01-01T00:00:00Z' })
      );

      const result = await getPreview('archive.zip');

      expect(result.type).toBe('binary');
      expect(result.size).toBe(1048576);
    });
  });

  // ==========================================================================
  // getDownloadUrl
  // ==========================================================================
  describe('getDownloadUrl', () => {
    it('returns URL string with encoded key', () => {
      const url = getDownloadUrl('docs/file.txt');
      expect(url).toBe('/api/storage/download?key=docs%2Ffile.txt');
    });

    it('handles keys with special characters', () => {
      const url = getDownloadUrl('path/to/my file (1).pdf');
      expect(url).toBe('/api/storage/download?key=path%2Fto%2Fmy+file+%281%29.pdf');
    });

    it('handles simple keys', () => {
      const url = getDownloadUrl('readme.md');
      expect(url).toBe('/api/storage/download?key=readme.md');
    });
  });

  // ==========================================================================
  // Error handling (storageFetch)
  // ==========================================================================
  describe('storageFetch error handling', () => {
    it('throws StorageApiError on non-ok response', async () => {
      mockFetch.mockResolvedValueOnce(mockErrorResponse('Forbidden', 403));

      await expect(browseStorage()).rejects.toThrow('Forbidden');
    });

    it('throws StorageApiError with HTTP status when error body is empty', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('', { status: 500 })
      );

      await expect(browseStorage()).rejects.toThrow('HTTP 500');
    });

    it('throws on empty response body', async () => {
      mockFetch.mockResolvedValueOnce(
        new Response('', { status: 200 })
      );

      await expect(browseStorage()).rejects.toThrow(
        'Expected response body but received empty response'
      );
    });

    it('includes Content-Type header when body is present', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ key: 'test.txt', size: 100 })
      );

      await uploadFile('test.txt', 'content');

      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[1].headers).toEqual(
        expect.objectContaining({ 'Content-Type': 'application/json' })
      );
    });

    it('does not include Content-Type header when body is absent', async () => {
      mockFetch.mockResolvedValueOnce(
        mockResponse({ objects: [], prefixes: [], isTruncated: false })
      );

      await browseStorage();

      const callArgs = mockFetch.mock.calls[0];
      // browseStorage sends no body, so Content-Type should not be set
      expect(callArgs[1].headers?.['Content-Type']).toBeUndefined();
    });
  });
});
