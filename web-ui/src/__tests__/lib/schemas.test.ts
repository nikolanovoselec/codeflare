import { describe, it, expect } from 'vitest';
import {
  StorageStatsResponseSchema,
  StoragePreviewTextResponseSchema,
  StoragePreviewImageResponseSchema,
  StoragePreviewBinaryResponseSchema,
} from '../../lib/schemas';

describe('Storage Stats Schema', () => {
  it('validates a complete stats response', () => {
    const data = { totalFiles: 42, totalFolders: 5, totalSizeBytes: 1048576 };
    expect(() => StorageStatsResponseSchema.parse(data)).not.toThrow();
    const parsed = StorageStatsResponseSchema.parse(data);
    expect(parsed.totalFiles).toBe(42);
    expect(parsed.totalFolders).toBe(5);
    expect(parsed.totalSizeBytes).toBe(1048576);
  });

  it('rejects missing totalFiles', () => {
    const data = { totalFolders: 5, totalSizeBytes: 1048576 };
    expect(() => StorageStatsResponseSchema.parse(data)).toThrow();
  });

  it('rejects missing totalFolders', () => {
    const data = { totalFiles: 42, totalSizeBytes: 1048576 };
    expect(() => StorageStatsResponseSchema.parse(data)).toThrow();
  });

  it('rejects missing totalSizeBytes', () => {
    const data = { totalFiles: 42, totalFolders: 5 };
    expect(() => StorageStatsResponseSchema.parse(data)).toThrow();
  });

  it('rejects non-number totalFiles', () => {
    const data = { totalFiles: 'many', totalFolders: 5, totalSizeBytes: 1048576 };
    expect(() => StorageStatsResponseSchema.parse(data)).toThrow();
  });

  it('accepts zero values', () => {
    const data = { totalFiles: 0, totalFolders: 0, totalSizeBytes: 0 };
    expect(() => StorageStatsResponseSchema.parse(data)).not.toThrow();
  });
});

describe('Storage Preview Text Schema', () => {
  it('validates a text preview response', () => {
    const data = {
      type: 'text' as const,
      content: 'Hello, world!',
      size: 13,
      lastModified: '2025-01-15T10:30:00Z',
    };
    expect(() => StoragePreviewTextResponseSchema.parse(data)).not.toThrow();
    const parsed = StoragePreviewTextResponseSchema.parse(data);
    expect(parsed.type).toBe('text');
    expect(parsed.content).toBe('Hello, world!');
    expect(parsed.size).toBe(13);
    expect(parsed.lastModified).toBe('2025-01-15T10:30:00Z');
  });

  it('rejects wrong type literal', () => {
    const data = { type: 'image', content: 'text', size: 4, lastModified: '2025-01-01T00:00:00Z' };
    expect(() => StoragePreviewTextResponseSchema.parse(data)).toThrow();
  });

  it('rejects missing content', () => {
    const data = { type: 'text', size: 13, lastModified: '2025-01-01T00:00:00Z' };
    expect(() => StoragePreviewTextResponseSchema.parse(data)).toThrow();
  });

  it('rejects missing size', () => {
    const data = { type: 'text', content: 'hi', lastModified: '2025-01-01T00:00:00Z' };
    expect(() => StoragePreviewTextResponseSchema.parse(data)).toThrow();
  });

  it('rejects missing lastModified', () => {
    const data = { type: 'text', content: 'hi', size: 2 };
    expect(() => StoragePreviewTextResponseSchema.parse(data)).toThrow();
  });
});

describe('Storage Preview Image Schema', () => {
  it('validates an image preview response', () => {
    const data = {
      type: 'image' as const,
      url: 'https://example.com/image.png',
      size: 204800,
      lastModified: '2025-01-15T10:30:00Z',
    };
    expect(() => StoragePreviewImageResponseSchema.parse(data)).not.toThrow();
    const parsed = StoragePreviewImageResponseSchema.parse(data);
    expect(parsed.type).toBe('image');
    expect(parsed.url).toBe('https://example.com/image.png');
  });

  it('rejects wrong type literal', () => {
    const data = { type: 'text', url: 'https://example.com/img.png', size: 100, lastModified: '2025-01-01T00:00:00Z' };
    expect(() => StoragePreviewImageResponseSchema.parse(data)).toThrow();
  });

  it('rejects missing url', () => {
    const data = { type: 'image', size: 100, lastModified: '2025-01-01T00:00:00Z' };
    expect(() => StoragePreviewImageResponseSchema.parse(data)).toThrow();
  });

  it('rejects missing size', () => {
    const data = { type: 'image', url: 'https://example.com/img.png', lastModified: '2025-01-01T00:00:00Z' };
    expect(() => StoragePreviewImageResponseSchema.parse(data)).toThrow();
  });

  it('rejects missing lastModified', () => {
    const data = { type: 'image', url: 'https://example.com/img.png', size: 100 };
    expect(() => StoragePreviewImageResponseSchema.parse(data)).toThrow();
  });
});

describe('Storage Preview Binary Schema', () => {
  it('validates a binary preview response', () => {
    const data = {
      type: 'binary' as const,
      size: 1048576,
      lastModified: '2025-01-15T10:30:00Z',
    };
    expect(() => StoragePreviewBinaryResponseSchema.parse(data)).not.toThrow();
    const parsed = StoragePreviewBinaryResponseSchema.parse(data);
    expect(parsed.type).toBe('binary');
    expect(parsed.size).toBe(1048576);
  });

  it('rejects wrong type literal', () => {
    const data = { type: 'text', size: 100, lastModified: '2025-01-01T00:00:00Z' };
    expect(() => StoragePreviewBinaryResponseSchema.parse(data)).toThrow();
  });

  it('rejects missing size', () => {
    const data = { type: 'binary', lastModified: '2025-01-01T00:00:00Z' };
    expect(() => StoragePreviewBinaryResponseSchema.parse(data)).toThrow();
  });

  it('rejects missing lastModified', () => {
    const data = { type: 'binary', size: 100 };
    expect(() => StoragePreviewBinaryResponseSchema.parse(data)).toThrow();
  });
});
