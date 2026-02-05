import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the API modules BEFORE importing the store
vi.mock('../../api/storage', () => ({
  browseStorage: vi.fn(),
  uploadFile: vi.fn(),
  initiateMultipartUpload: vi.fn(),
  uploadPart: vi.fn(),
  completeMultipartUpload: vi.fn(),
  abortMultipartUpload: vi.fn(),
  deleteFiles: vi.fn(),
  moveFile: vi.fn(),
  getStats: vi.fn(),
  getPreview: vi.fn(),
}));

// Mock file-upload helpers
vi.mock('../../lib/file-upload', () => ({
  shouldUseMultipart: vi.fn((file: File) => file.size > 5 * 1024 * 1024),
  splitIntoParts: vi.fn((file: File) => [file.slice(0, file.size)]),
  fileToBase64: vi.fn(() => Promise.resolve('base64content')),
}));

import * as storageApi from '../../api/storage';
import { shouldUseMultipart, splitIntoParts } from '../../lib/file-upload';
import { storageStore, _resetForTests } from '../../stores/storage';

// Get typed mocks
const mockBrowseStorage = vi.mocked(storageApi.browseStorage);
const mockUploadFile = vi.mocked(storageApi.uploadFile);
const mockInitiateMultipartUpload = vi.mocked(storageApi.initiateMultipartUpload);
const mockUploadPart = vi.mocked(storageApi.uploadPart);
const mockCompleteMultipartUpload = vi.mocked(storageApi.completeMultipartUpload);
const mockDeleteFiles = vi.mocked(storageApi.deleteFiles);
const mockMoveFile = vi.mocked(storageApi.moveFile);
const mockGetStats = vi.mocked(storageApi.getStats);
const mockGetPreview = vi.mocked(storageApi.getPreview);
const mockShouldUseMultipart = vi.mocked(shouldUseMultipart);
const mockSplitIntoParts = vi.mocked(splitIntoParts);

describe('Storage Store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetForTests();
  });

  describe('initial state', () => {
    it('should have correct defaults', () => {
      expect(storageStore.currentPrefix).toBe('workspace/');
      expect(storageStore.objects).toEqual([]);
      expect(storageStore.prefixes).toEqual([]);
      expect(storageStore.loading).toBe(false);
      expect(storageStore.error).toBeNull();
      expect(storageStore.uploads).toEqual([]);
      expect(storageStore.selectedKeys).toEqual([]);
      expect(storageStore.selectedPrefixes).toEqual([]);
      expect(storageStore.isTruncated).toBe(false);
      expect(storageStore.nextContinuationToken).toBeNull();
    });
  });

  describe('browse()', () => {
    it('should call browseStorage API and set objects/prefixes/isTruncated', async () => {
      mockBrowseStorage.mockResolvedValue({
        objects: [
          { key: 'workspace/file.txt', size: 100, lastModified: '2025-01-01T00:00:00Z' },
        ],
        prefixes: ['workspace/subdir/'],
        isTruncated: true,
        nextContinuationToken: 'token-abc',
      });

      await storageStore.browse();

      expect(mockBrowseStorage).toHaveBeenCalledWith('workspace/');
      expect(storageStore.objects).toEqual([
        { key: 'workspace/file.txt', size: 100, lastModified: '2025-01-01T00:00:00Z' },
      ]);
      expect(storageStore.prefixes).toEqual(['workspace/subdir/']);
      expect(storageStore.isTruncated).toBe(true);
      expect(storageStore.nextContinuationToken).toBe('token-abc');
    });

    it('should set loading=true before call and loading=false after', async () => {
      let resolvePromise: (value: any) => void;
      mockBrowseStorage.mockReturnValue(
        new Promise((resolve) => { resolvePromise = resolve; })
      );

      const browsePromise = storageStore.browse();
      expect(storageStore.loading).toBe(true);

      resolvePromise!({
        objects: [],
        prefixes: [],
        isTruncated: false,
      });
      await browsePromise;

      expect(storageStore.loading).toBe(false);
    });

    it('should set error on API failure', async () => {
      mockBrowseStorage.mockRejectedValue(new Error('Network error'));

      await storageStore.browse();

      expect(storageStore.error).toBe('Network error');
      expect(storageStore.loading).toBe(false);
    });

    it('should browse a specific prefix when provided', async () => {
      mockBrowseStorage.mockResolvedValue({
        objects: [],
        prefixes: [],
        isTruncated: false,
      });

      await storageStore.browse('workspace/subdir/');

      expect(mockBrowseStorage).toHaveBeenCalledWith('workspace/subdir/');
    });
  });

  describe('navigateTo()', () => {
    it('should update currentPrefix and call browse', async () => {
      mockBrowseStorage.mockResolvedValue({
        objects: [],
        prefixes: [],
        isTruncated: false,
      });

      await storageStore.navigateTo('workspace/project/');

      expect(storageStore.currentPrefix).toBe('workspace/project/');
      expect(mockBrowseStorage).toHaveBeenCalledWith('workspace/project/');
    });

    it('should clear selection when navigating', async () => {
      mockBrowseStorage.mockResolvedValue({
        objects: [
          { key: 'workspace/file.txt', size: 100, lastModified: '2025-01-01T00:00:00Z' },
        ],
        prefixes: [],
        isTruncated: false,
      });

      // First browse and select a file
      await storageStore.browse();
      storageStore.toggleSelect('workspace/file.txt');
      expect(storageStore.selectedKeys.length).toBe(1);

      // Navigate should clear selection
      await storageStore.navigateTo('workspace/other/');
      expect(storageStore.selectedKeys).toEqual([]);
      expect(storageStore.selectedPrefixes).toEqual([]);
    });
  });

  describe('navigateUp()', () => {
    it('should go from workspace/project/ to workspace/ and call browse', async () => {
      mockBrowseStorage.mockResolvedValue({
        objects: [],
        prefixes: [],
        isTruncated: false,
      });

      // First navigate to a deeper path
      await storageStore.navigateTo('workspace/project/');
      vi.clearAllMocks();

      await storageStore.navigateUp();

      expect(storageStore.currentPrefix).toBe('workspace/');
      expect(mockBrowseStorage).toHaveBeenCalledWith('workspace/');
    });

    it('should navigate from single-segment prefix to root', async () => {
      mockBrowseStorage.mockResolvedValue({
        objects: [],
        prefixes: [],
        isTruncated: false,
      });

      // Default prefix is 'workspace/' which is a single segment
      await storageStore.navigateUp();

      // Should navigate to root '' (empty prefix)
      expect(mockBrowseStorage).toHaveBeenCalledWith('');
      expect(storageStore.currentPrefix).toBe('');
    });

    it('should stay at root when already at root', async () => {
      mockBrowseStorage.mockResolvedValue({
        objects: [],
        prefixes: [],
        isTruncated: false,
      });

      // Navigate to root first
      await storageStore.navigateTo('');
      vi.clearAllMocks();

      // Now navigateUp from root should be a no-op
      await storageStore.navigateUp();

      expect(mockBrowseStorage).not.toHaveBeenCalled();
      expect(storageStore.currentPrefix).toBe('');
    });
  });

  describe('breadcrumbs', () => {
    it('should derive breadcrumbs from currentPrefix', async () => {
      mockBrowseStorage.mockResolvedValue({
        objects: [],
        prefixes: [],
        isTruncated: false,
      });

      await storageStore.navigateTo('workspace/project/src/');

      expect(storageStore.breadcrumbs).toEqual([
        'workspace/',
        'workspace/project/',
        'workspace/project/src/',
      ]);
    });

    it('should return single breadcrumb at root', () => {
      expect(storageStore.breadcrumbs).toEqual(['workspace/']);
    });
  });

  describe('uploadFiles()', () => {
    it('should add upload items with pending status', async () => {
      mockShouldUseMultipart.mockReturnValue(false);
      mockUploadFile.mockResolvedValue({ key: 'workspace/file.txt' });
      mockBrowseStorage.mockResolvedValue({
        objects: [],
        prefixes: [],
        isTruncated: false,
      });

      const file = new File(['hello'], 'file.txt', { type: 'text/plain' });
      const files = [{ file, relativePath: 'file.txt' }];

      await storageStore.uploadFiles(files, 'workspace/');

      // After upload completes, should have an upload item
      expect(storageStore.uploads.length).toBe(1);
      expect(storageStore.uploads[0].fileName).toBe('file.txt');
      expect(storageStore.uploads[0].status).toBe('complete');
      expect(storageStore.uploads[0].progress).toBe(100);
    });

    it('should use uploadFile API for small files (<5MB)', async () => {
      mockShouldUseMultipart.mockReturnValue(false);
      mockUploadFile.mockResolvedValue({ key: 'workspace/small.txt' });
      mockBrowseStorage.mockResolvedValue({
        objects: [],
        prefixes: [],
        isTruncated: false,
      });

      const file = new File(['small content'], 'small.txt', { type: 'text/plain' });
      const files = [{ file, relativePath: 'small.txt' }];

      await storageStore.uploadFiles(files, 'workspace/');

      expect(mockUploadFile).toHaveBeenCalledWith('workspace/small.txt', 'base64content');
      expect(mockInitiateMultipartUpload).not.toHaveBeenCalled();
    });

    it('should use multipart upload flow for large files (>5MB)', async () => {
      mockShouldUseMultipart.mockReturnValue(true);
      // Return two parts for progress testing
      const blob1 = new Blob(['part1']);
      const blob2 = new Blob(['part2']);
      mockSplitIntoParts.mockReturnValue([blob1, blob2]);
      mockInitiateMultipartUpload.mockResolvedValue({
        uploadId: 'upload-123',
        key: 'workspace/large.bin',
      });
      mockUploadPart.mockResolvedValueOnce({ etag: 'etag-1' });
      mockUploadPart.mockResolvedValueOnce({ etag: 'etag-2' });
      mockCompleteMultipartUpload.mockResolvedValue({ key: 'workspace/large.bin' });
      mockBrowseStorage.mockResolvedValue({
        objects: [],
        prefixes: [],
        isTruncated: false,
      });

      // Create a >5MB file (we control the mock, so size doesn't actually matter)
      const largeContent = new ArrayBuffer(6 * 1024 * 1024);
      const file = new File([largeContent], 'large.bin');
      const files = [{ file, relativePath: 'large.bin' }];

      await storageStore.uploadFiles(files, 'workspace/');

      expect(mockInitiateMultipartUpload).toHaveBeenCalledWith('workspace/large.bin');
      expect(mockUploadPart).toHaveBeenCalledTimes(2);
      expect(mockCompleteMultipartUpload).toHaveBeenCalledWith(
        'workspace/large.bin',
        'upload-123',
        [
          { partNumber: 1, etag: 'etag-1' },
          { partNumber: 2, etag: 'etag-2' },
        ]
      );
    });

    it('should update progress for each part during multipart upload', async () => {
      mockShouldUseMultipart.mockReturnValue(true);
      const blob1 = new Blob(['part1']);
      const blob2 = new Blob(['part2']);
      mockSplitIntoParts.mockReturnValue([blob1, blob2]);
      mockInitiateMultipartUpload.mockResolvedValue({
        uploadId: 'upload-456',
        key: 'workspace/big.bin',
      });

      // Track progress during upload
      const progressValues: number[] = [];
      mockUploadPart.mockImplementation(async () => {
        // After this resolves, the store updates progress
        return { etag: `etag-${progressValues.length + 1}` };
      });
      mockCompleteMultipartUpload.mockResolvedValue({ key: 'workspace/big.bin' });
      mockBrowseStorage.mockResolvedValue({
        objects: [],
        prefixes: [],
        isTruncated: false,
      });

      const largeContent = new ArrayBuffer(6 * 1024 * 1024);
      const file = new File([largeContent], 'big.bin');
      const files = [{ file, relativePath: 'big.bin' }];

      await storageStore.uploadFiles(files, 'workspace/');

      // Final state should be complete with 100% progress
      expect(storageStore.uploads[0].progress).toBe(100);
      expect(storageStore.uploads[0].status).toBe('complete');
    });

    it('should mark upload as error on failure', async () => {
      mockShouldUseMultipart.mockReturnValue(false);
      mockUploadFile.mockRejectedValue(new Error('Upload failed'));
      mockBrowseStorage.mockResolvedValue({
        objects: [],
        prefixes: [],
        isTruncated: false,
      });

      const file = new File(['content'], 'fail.txt', { type: 'text/plain' });
      const files = [{ file, relativePath: 'fail.txt' }];

      await storageStore.uploadFiles(files, 'workspace/');

      expect(storageStore.uploads[0].status).toBe('error');
      expect(storageStore.uploads[0].error).toBe('Upload failed');
    });

    it('should refresh listing after all uploads', async () => {
      mockShouldUseMultipart.mockReturnValue(false);
      mockUploadFile.mockResolvedValue({ key: 'workspace/file.txt' });
      mockBrowseStorage.mockResolvedValue({
        objects: [],
        prefixes: [],
        isTruncated: false,
      });

      const file = new File(['content'], 'file.txt', { type: 'text/plain' });
      const files = [{ file, relativePath: 'file.txt' }];

      await storageStore.uploadFiles(files, 'workspace/');

      // browse should be called to refresh listing
      expect(mockBrowseStorage).toHaveBeenCalled();
    });
  });

  describe('deleteSelected()', () => {
    beforeEach(async () => {
      mockBrowseStorage.mockResolvedValue({
        objects: [
          { key: 'workspace/a.txt', size: 10, lastModified: '2025-01-01T00:00:00Z' },
          { key: 'workspace/b.txt', size: 20, lastModified: '2025-01-01T00:00:00Z' },
        ],
        prefixes: [],
        isTruncated: false,
      });
      await storageStore.browse();
    });

    it('should call deleteFiles API with selected keys', async () => {
      mockDeleteFiles.mockResolvedValue({ deleted: ['workspace/a.txt'], errors: [] });
      mockBrowseStorage.mockResolvedValue({
        objects: [
          { key: 'workspace/b.txt', size: 20, lastModified: '2025-01-01T00:00:00Z' },
        ],
        prefixes: [],
        isTruncated: false,
      });

      storageStore.toggleSelect('workspace/a.txt');
      await storageStore.deleteSelected();

      expect(mockDeleteFiles).toHaveBeenCalledWith(['workspace/a.txt']);
    });

    it('should refresh listing after successful delete', async () => {
      mockDeleteFiles.mockResolvedValue({ deleted: ['workspace/a.txt'], errors: [] });

      storageStore.toggleSelect('workspace/a.txt');
      vi.clearAllMocks();
      mockBrowseStorage.mockResolvedValue({
        objects: [],
        prefixes: [],
        isTruncated: false,
      });

      await storageStore.deleteSelected();

      expect(mockBrowseStorage).toHaveBeenCalled();
    });

    it('should clear selection after delete', async () => {
      mockDeleteFiles.mockResolvedValue({ deleted: ['workspace/a.txt'], errors: [] });
      mockBrowseStorage.mockResolvedValue({
        objects: [],
        prefixes: [],
        isTruncated: false,
      });

      storageStore.toggleSelect('workspace/a.txt');
      await storageStore.deleteSelected();

      expect(storageStore.selectedKeys).toEqual([]);
      expect(storageStore.selectedPrefixes).toEqual([]);
    });

    it('should do nothing when no keys are selected', async () => {
      await storageStore.deleteSelected();

      expect(mockDeleteFiles).not.toHaveBeenCalled();
    });

    it('should delete keys under selected prefixes', async () => {
      mockBrowseStorage
        .mockResolvedValueOnce({
          objects: [
            { key: 'workspace/folder/a.txt', size: 10, lastModified: '2025-01-01T00:00:00Z' },
            { key: 'workspace/folder/b.txt', size: 20, lastModified: '2025-01-01T00:00:00Z' },
          ],
          prefixes: [],
          isTruncated: false,
        })
        .mockResolvedValueOnce({
          objects: [],
          prefixes: [],
          isTruncated: false,
        });

      storageStore.toggleSelectPrefix('workspace/folder/');
      await storageStore.deleteSelected();

      expect(mockBrowseStorage).toHaveBeenCalledWith('workspace/folder/', undefined);
      expect(mockDeleteFiles).toHaveBeenCalledWith(['workspace/folder/a.txt', 'workspace/folder/b.txt']);
      expect(storageStore.selectedPrefixes).toEqual([]);
    });
  });

  describe('moveFile()', () => {
    it('should call moveFile API and refresh listing', async () => {
      mockMoveFile.mockResolvedValue({
        source: 'workspace/old.txt',
        destination: 'workspace/new.txt',
      });
      mockBrowseStorage.mockResolvedValue({
        objects: [],
        prefixes: [],
        isTruncated: false,
      });

      await storageStore.moveFile('workspace/old.txt', 'workspace/new.txt');

      expect(mockMoveFile).toHaveBeenCalledWith('workspace/old.txt', 'workspace/new.txt');
      expect(mockBrowseStorage).toHaveBeenCalled();
    });

    it('should set error on failure', async () => {
      mockMoveFile.mockRejectedValue(new Error('Move failed'));

      await storageStore.moveFile('workspace/a.txt', 'workspace/b.txt');

      expect(storageStore.error).toBe('Move failed');
    });
  });

  describe('selection', () => {
    it('toggleSelect should add key to selectedKeys', () => {
      storageStore.toggleSelect('workspace/file.txt');

      expect(storageStore.selectedKeys).toContain('workspace/file.txt');
    });

    it('toggleSelect should remove key if already selected', () => {
      storageStore.toggleSelect('workspace/file.txt');
      storageStore.toggleSelect('workspace/file.txt');

      expect(storageStore.selectedKeys).not.toContain('workspace/file.txt');
    });

    it('toggleSelectPrefix should add/remove prefix', () => {
      storageStore.toggleSelectPrefix('workspace/folder/');
      expect(storageStore.selectedPrefixes).toContain('workspace/folder/');

      storageStore.toggleSelectPrefix('workspace/folder/');
      expect(storageStore.selectedPrefixes).not.toContain('workspace/folder/');
    });

    it('selectAll should select all objects', async () => {
      mockBrowseStorage.mockResolvedValue({
        objects: [
          { key: 'workspace/a.txt', size: 10, lastModified: '2025-01-01T00:00:00Z' },
          { key: 'workspace/b.txt', size: 20, lastModified: '2025-01-01T00:00:00Z' },
        ],
        prefixes: ['workspace/folder/'],
        isTruncated: false,
      });
      await storageStore.browse();

      storageStore.selectAll();

      expect(storageStore.selectedKeys).toEqual(['workspace/a.txt', 'workspace/b.txt']);
      expect(storageStore.selectedPrefixes).toEqual(['workspace/folder/']);
    });

    it('clearSelection should empty selectedKeys', () => {
      storageStore.toggleSelect('workspace/file.txt');
      storageStore.clearSelection();

      expect(storageStore.selectedKeys).toEqual([]);
      expect(storageStore.selectedPrefixes).toEqual([]);
    });
  });

  describe('refresh()', () => {
    it('should call browse with current prefix', async () => {
      mockBrowseStorage.mockResolvedValue({
        objects: [],
        prefixes: [],
        isTruncated: false,
      });

      await storageStore.refresh();

      expect(mockBrowseStorage).toHaveBeenCalledWith('workspace/');
    });
  });

  // ==========================================================================
  // fetchStats
  // ==========================================================================
  describe('fetchStats()', () => {
    it('should call getStats API and set stats state', async () => {
      mockGetStats.mockResolvedValue({
        totalFiles: 42,
        totalFolders: 5,
        totalSizeBytes: 1048576,
      });

      await storageStore.fetchStats();

      expect(mockGetStats).toHaveBeenCalled();
      expect(storageStore.stats).toEqual({
        totalFiles: 42,
        totalFolders: 5,
        totalSizeBytes: 1048576,
      });
    });

    it('should set error on failure', async () => {
      mockGetStats.mockRejectedValue(new Error('Stats unavailable'));

      await storageStore.fetchStats();

      expect(storageStore.error).toBe('Stats unavailable');
    });

    it('should have null stats initially', () => {
      expect(storageStore.stats).toBeNull();
    });
  });

  // ==========================================================================
  // openPreview / closePreview
  // ==========================================================================
  describe('openPreview()', () => {
    it('should call getPreview API and set previewFile state', async () => {
      mockGetPreview.mockResolvedValue({
        type: 'text' as const,
        content: 'file content',
        size: 12,
        lastModified: '2025-01-01T00:00:00Z',
      });

      await storageStore.openPreview('workspace/file.txt');

      expect(mockGetPreview).toHaveBeenCalledWith('workspace/file.txt');
      expect(storageStore.previewFile).toEqual({
        key: 'workspace/file.txt',
        type: 'text',
        content: 'file content',
        size: 12,
        lastModified: '2025-01-01T00:00:00Z',
      });
    });

    it('should handle image preview', async () => {
      mockGetPreview.mockResolvedValue({
        type: 'image' as const,
        url: 'https://example.com/img.png',
        size: 204800,
        lastModified: '2025-01-01T00:00:00Z',
      });

      await storageStore.openPreview('workspace/photo.png');

      expect(storageStore.previewFile).toEqual({
        key: 'workspace/photo.png',
        type: 'image',
        url: 'https://example.com/img.png',
        size: 204800,
        lastModified: '2025-01-01T00:00:00Z',
      });
    });

    it('should handle binary preview', async () => {
      mockGetPreview.mockResolvedValue({
        type: 'binary' as const,
        size: 1048576,
        lastModified: '2025-01-01T00:00:00Z',
      });

      await storageStore.openPreview('workspace/archive.zip');

      expect(storageStore.previewFile).toEqual({
        key: 'workspace/archive.zip',
        type: 'binary',
        size: 1048576,
        lastModified: '2025-01-01T00:00:00Z',
      });
    });

    it('should set error on failure', async () => {
      mockGetPreview.mockRejectedValue(new Error('Preview failed'));

      await storageStore.openPreview('workspace/file.txt');

      expect(storageStore.error).toBe('Preview failed');
      expect(storageStore.previewFile).toBeNull();
    });
  });

  describe('closePreview()', () => {
    it('should clear previewFile', async () => {
      mockGetPreview.mockResolvedValue({
        type: 'text' as const,
        content: 'hello',
        size: 5,
        lastModified: '2025-01-01T00:00:00Z',
      });

      await storageStore.openPreview('workspace/file.txt');
      expect(storageStore.previewFile).not.toBeNull();

      storageStore.closePreview();
      expect(storageStore.previewFile).toBeNull();
    });

    it('should have null previewFile initially', () => {
      expect(storageStore.previewFile).toBeNull();
    });
  });

  // ==========================================================================
  // searchFiles (client-side filter)
  // ==========================================================================
  describe('searchFiles()', () => {
    beforeEach(async () => {
      mockBrowseStorage.mockResolvedValue({
        objects: [
          { key: 'workspace/readme.md', size: 100, lastModified: '2025-01-01T00:00:00Z' },
          { key: 'workspace/index.ts', size: 200, lastModified: '2025-01-01T00:00:00Z' },
          { key: 'workspace/app.tsx', size: 300, lastModified: '2025-01-01T00:00:00Z' },
        ],
        prefixes: ['workspace/src/', 'workspace/docs/'],
        isTruncated: false,
      });
      await storageStore.browse();
    });

    it('should filter objects by query (case-insensitive)', () => {
      const results = storageStore.searchFiles('readme');
      expect(results.objects).toEqual([
        { key: 'workspace/readme.md', size: 100, lastModified: '2025-01-01T00:00:00Z' },
      ]);
    });

    it('should filter prefixes by query', () => {
      const results = storageStore.searchFiles('src');
      expect(results.prefixes).toEqual(['workspace/src/']);
    });

    it('should return all when query is empty', () => {
      const results = storageStore.searchFiles('');
      expect(results.objects).toHaveLength(3);
      expect(results.prefixes).toHaveLength(2);
    });

    it('should match partial file names', () => {
      const results = storageStore.searchFiles('.ts');
      expect(results.objects).toHaveLength(2); // index.ts and app.tsx
    });

    it('should return empty when nothing matches', () => {
      const results = storageStore.searchFiles('nonexistent');
      expect(results.objects).toEqual([]);
      expect(results.prefixes).toEqual([]);
    });
  });

  describe('deepSearch()', () => {
    it('should call browseStorage with the query as prefix appended to root', async () => {
      mockBrowseStorage.mockResolvedValue({
        objects: [
          { key: 'workspace/src/utils.ts', size: 100, lastModified: '2025-01-01T00:00:00Z' },
        ],
        prefixes: [],
        isTruncated: false,
      });

      const results = await storageStore.deepSearch('src/');

      expect(mockBrowseStorage).toHaveBeenCalledWith('workspace/src/');
      expect(results.objects).toHaveLength(1);
      expect(results.objects[0].key).toBe('workspace/src/utils.ts');
    });

    it('should return empty result on error', async () => {
      mockBrowseStorage.mockRejectedValue(new Error('Search failed'));

      const results = await storageStore.deepSearch('missing/');

      expect(results.objects).toEqual([]);
      expect(results.prefixes).toEqual([]);
    });
  });
});
