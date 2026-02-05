import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  extractFilesFromDrop,
  shouldUseMultipart,
  splitIntoParts,
  fileToBase64,
  type FileWithPath,
} from '../../lib/file-upload';

// --- Helpers ---

function createMockFile(name: string, size: number, type = 'text/plain'): File {
  const content = new Uint8Array(size);
  return new File([content], name, { type });
}

interface MockEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: File;
  children?: MockEntry[];
}

function createMockFileEntry(name: string, file: File): MockEntry {
  return {
    isFile: true,
    isDirectory: false,
    name,
    file,
  };
}

function createMockDirEntry(name: string, children: MockEntry[]): MockEntry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    children,
  };
}

/**
 * Build a mock DataTransfer with webkitGetAsEntry support.
 * Each entry can be a file or directory (with nested children).
 */
function createMockDataTransfer(entries: MockEntry[]): DataTransfer {
  // Build items with webkitGetAsEntry
  const items = entries.map((entry) => ({
    webkitGetAsEntry: () => buildFileSystemEntry(entry),
  }));

  return {
    items: {
      length: items.length,
      ...items.reduce(
        (acc, item, i) => {
          acc[i] = item;
          return acc;
        },
        {} as Record<number, (typeof items)[0]>
      ),
    },
    files: {
      length: entries.filter((e) => e.isFile).length,
      ...entries
        .filter((e) => e.isFile)
        .reduce(
          (acc, entry, i) => {
            acc[i] = entry.file!;
            return acc;
          },
          {} as Record<number, File>
        ),
    },
  } as unknown as DataTransfer;
}

function buildFileSystemEntry(entry: MockEntry): FileSystemEntry {
  if (entry.isFile) {
    return {
      isFile: true,
      isDirectory: false,
      name: entry.name,
      fullPath: '/' + entry.name,
      filesystem: {} as FileSystem,
      getParent: vi.fn(),
      file: (success: (file: File) => void) => success(entry.file!),
    } as unknown as FileSystemEntry;
  }

  // Directory entry
  const children = entry.children || [];
  const childEntries = children.map((c) => buildFileSystemEntry(c));

  // Simulate Chrome's batch limit: return entries in batches
  let readIndex = 0;
  const createReader = () => ({
    readEntries: (success: (entries: FileSystemEntry[]) => void) => {
      // Return all remaining entries in first call, empty on second
      if (readIndex === 0) {
        readIndex = childEntries.length;
        success(childEntries);
      } else {
        success([]);
      }
    },
  });

  return {
    isFile: false,
    isDirectory: true,
    name: entry.name,
    fullPath: '/' + entry.name,
    filesystem: {} as FileSystem,
    getParent: vi.fn(),
    createReader,
  } as unknown as FileSystemEntry;
}

/** Create a DataTransfer with NO items API (fallback path) */
function createFallbackDataTransfer(files: File[]): DataTransfer {
  return {
    items: undefined,
    files: {
      length: files.length,
      ...files.reduce(
        (acc, f, i) => {
          acc[i] = f;
          return acc;
        },
        {} as Record<number, File>
      ),
    },
  } as unknown as DataTransfer;
}

// --- Tests ---

describe('shouldUseMultipart', () => {
  it('returns false for files <= 5MB', () => {
    const file = createMockFile('small.txt', 5 * 1024 * 1024);
    expect(shouldUseMultipart(file)).toBe(false);
  });

  it('returns true for files > 5MB', () => {
    const file = createMockFile('big.txt', 5 * 1024 * 1024 + 1);
    expect(shouldUseMultipart(file)).toBe(true);
  });

  it('returns false for empty files', () => {
    const file = createMockFile('empty.txt', 0);
    expect(shouldUseMultipart(file)).toBe(false);
  });

  it('returns false for files just under threshold', () => {
    const file = createMockFile('almost.txt', 5 * 1024 * 1024 - 1);
    expect(shouldUseMultipart(file)).toBe(false);
  });
});

describe('splitIntoParts', () => {
  it('splits a 12MB file into 3 parts (5MB + 5MB + 2MB)', () => {
    const size = 12 * 1024 * 1024;
    const file = createMockFile('medium.bin', size);
    const parts = splitIntoParts(file);

    expect(parts).toHaveLength(3);
    expect(parts[0].size).toBe(5 * 1024 * 1024);
    expect(parts[1].size).toBe(5 * 1024 * 1024);
    expect(parts[2].size).toBe(2 * 1024 * 1024);
  });

  it('uses 10MB parts for files > 100MB', () => {
    const size = 105 * 1024 * 1024;
    const file = createMockFile('huge.bin', size);
    const parts = splitIntoParts(file);

    // 105MB / 10MB = 10 full parts + 5MB remainder = 11 parts
    expect(parts).toHaveLength(11);
    expect(parts[0].size).toBe(10 * 1024 * 1024);
    expect(parts[parts.length - 1].size).toBe(5 * 1024 * 1024);
  });

  it('returns a single part for a file just over threshold', () => {
    const size = 5 * 1024 * 1024 + 100;
    const file = createMockFile('justover.bin', size);
    const parts = splitIntoParts(file);

    expect(parts).toHaveLength(2);
    expect(parts[0].size).toBe(5 * 1024 * 1024);
    expect(parts[1].size).toBe(100);
  });

  it('returns exactly one part for a file exactly 5MB', () => {
    const size = 5 * 1024 * 1024;
    const file = createMockFile('exact.bin', size);
    const parts = splitIntoParts(file);

    expect(parts).toHaveLength(1);
    expect(parts[0].size).toBe(size);
  });

  it('uses 5MB parts for files at exactly 100MB boundary', () => {
    const size = 100 * 1024 * 1024;
    const file = createMockFile('boundary.bin', size);
    const parts = splitIntoParts(file);

    // 100MB / 5MB = 20 parts
    expect(parts).toHaveLength(20);
    expect(parts[0].size).toBe(5 * 1024 * 1024);
  });
});

describe('extractFilesFromDrop', () => {
  it('extracts flat files from DataTransfer', async () => {
    const file1 = createMockFile('readme.md', 100, 'text/markdown');
    const file2 = createMockFile('index.ts', 200, 'text/typescript');

    const dt = createMockDataTransfer([
      createMockFileEntry('readme.md', file1),
      createMockFileEntry('index.ts', file2),
    ]);

    const result = await extractFilesFromDrop(dt);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ file: file1, relativePath: 'readme.md' });
    expect(result[1]).toEqual({ file: file2, relativePath: 'index.ts' });
  });

  it('extracts files from nested directories', async () => {
    const srcFile = createMockFile('main.ts', 300);
    const nestedFile = createMockFile('utils.ts', 150);

    const dt = createMockDataTransfer([
      createMockDirEntry('project', [
        createMockFileEntry('main.ts', srcFile),
        createMockDirEntry('lib', [createMockFileEntry('utils.ts', nestedFile)]),
      ]),
    ]);

    const result = await extractFilesFromDrop(dt);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ file: srcFile, relativePath: 'project/main.ts' });
    expect(result[1]).toEqual({ file: nestedFile, relativePath: 'project/lib/utils.ts' });
  });

  it('falls back to dataTransfer.files when items unavailable', async () => {
    const file1 = createMockFile('fallback.txt', 50);
    const file2 = createMockFile('other.txt', 75);

    const dt = createFallbackDataTransfer([file1, file2]);

    const result = await extractFilesFromDrop(dt);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ file: file1, relativePath: 'fallback.txt' });
    expect(result[1]).toEqual({ file: file2, relativePath: 'other.txt' });
  });

  it('handles mixed files and directories', async () => {
    const rootFile = createMockFile('README.md', 100);
    const dirFile = createMockFile('app.ts', 200);

    const dt = createMockDataTransfer([
      createMockFileEntry('README.md', rootFile),
      createMockDirEntry('src', [createMockFileEntry('app.ts', dirFile)]),
    ]);

    const result = await extractFilesFromDrop(dt);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({ file: rootFile, relativePath: 'README.md' });
    expect(result[1]).toEqual({ file: dirFile, relativePath: 'src/app.ts' });
  });

  it('handles empty DataTransfer', async () => {
    const dt = createMockDataTransfer([]);
    const result = await extractFilesFromDrop(dt);
    expect(result).toHaveLength(0);
  });
});

describe('fileToBase64', () => {
  let OriginalFileReader: typeof FileReader;

  beforeEach(() => {
    OriginalFileReader = globalThis.FileReader;

    class MockFileReader {
      result: string | null = null;
      onload: (() => void) | null = null;
      onerror: ((e: ProgressEvent) => void) | null = null;

      readAsDataURL(file: File) {
        this.result = `data:${file.type || 'application/octet-stream'};base64,dGVzdA==`;
        setTimeout(() => this.onload?.(), 0);
      }
    }

    globalThis.FileReader = MockFileReader as unknown as typeof FileReader;
  });

  // Restore original FileReader after tests (setup.ts may have its own)
  afterEach(() => {
    globalThis.FileReader = OriginalFileReader;
  });

  it('converts file to base64 string', async () => {
    const file = createMockFile('test.txt', 10, 'text/plain');
    const result = await fileToBase64(file);
    expect(result).toBe('dGVzdA==');
  });

  it('strips the data URL prefix', async () => {
    const file = createMockFile('image.png', 50, 'image/png');
    const result = await fileToBase64(file);
    // Should NOT contain the "data:..." prefix
    expect(result).not.toContain('data:');
    expect(result).not.toContain('base64,');
  });

  it('handles file with no type', async () => {
    const file = createMockFile('unknown', 10, '');
    const result = await fileToBase64(file);
    expect(result).toBe('dGVzdA==');
  });
});
