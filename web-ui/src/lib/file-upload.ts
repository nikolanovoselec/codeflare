export interface FileWithPath {
  file: File;
  relativePath: string;
}

const MULTIPART_THRESHOLD = 5 * 1024 * 1024; // 5MB
const MIN_PART_SIZE = 5 * 1024 * 1024; // 5MB minimum for R2
const LARGE_PART_SIZE = 10 * 1024 * 1024; // 10MB for files > 100MB

/**
 * Extract all files from a DataTransfer (drag & drop), including folder contents.
 * Uses webkitGetAsEntry() for folder traversal.
 * Chrome returns max 100 entries per readEntries() call -- must loop.
 */
export async function extractFilesFromDrop(dataTransfer: DataTransfer): Promise<FileWithPath[]> {
  const files: FileWithPath[] = [];
  const items = dataTransfer.items;

  if (!items) {
    // Fallback for browsers without items API
    for (let i = 0; i < dataTransfer.files.length; i++) {
      const file = dataTransfer.files[i];
      files.push({ file, relativePath: file.name });
    }
    return files;
  }

  const entries: FileSystemEntry[] = [];
  for (let i = 0; i < items.length; i++) {
    const entry = (items[i] as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntry | null }).webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }

  for (const entry of entries) {
    if (entry.isFile) {
      const file = await new Promise<File>((resolve, reject) => {
        (entry as FileSystemFileEntry).file(resolve, reject);
      });
      files.push({ file, relativePath: entry.name });
    } else if (entry.isDirectory) {
      const dirFiles = await traverseDirectory(entry as FileSystemDirectoryEntry, entry.name);
      files.push(...dirFiles);
    }
  }

  return files;
}

/**
 * Read all entries from a directory reader.
 * Handles Chrome's 100-entry-per-call batch limit by looping until empty.
 */
async function readAllEntries(reader: FileSystemDirectoryReader): Promise<FileSystemEntry[]> {
  const allEntries: FileSystemEntry[] = [];
  let batch: FileSystemEntry[];
  do {
    batch = await new Promise<FileSystemEntry[]>((resolve, reject) => {
      reader.readEntries(resolve, reject);
    });
    allEntries.push(...batch);
  } while (batch.length > 0);
  return allEntries;
}

/**
 * Recursively traverse a FileSystemDirectoryEntry.
 */
async function traverseDirectory(
  entry: FileSystemDirectoryEntry,
  path: string
): Promise<FileWithPath[]> {
  const files: FileWithPath[] = [];
  const reader = entry.createReader();
  const entries = await readAllEntries(reader);

  for (const child of entries) {
    if (child.isFile) {
      const file = await new Promise<File>((resolve, reject) => {
        (child as FileSystemFileEntry).file(resolve, reject);
      });
      files.push({ file, relativePath: `${path}/${child.name}` });
    } else if (child.isDirectory) {
      const subFiles = await traverseDirectory(
        child as FileSystemDirectoryEntry,
        `${path}/${child.name}`
      );
      files.push(...subFiles);
    }
  }

  return files;
}

/**
 * Determine if a file should use multipart upload (> 5MB).
 */
export function shouldUseMultipart(file: File): boolean {
  return file.size > MULTIPART_THRESHOLD;
}

/**
 * Split a file into parts for multipart upload.
 * Part size: 5MB minimum (R2 requirement), 10MB for files > 100MB.
 */
export function splitIntoParts(file: File): Blob[] {
  const partSize = file.size > 100 * 1024 * 1024 ? LARGE_PART_SIZE : MIN_PART_SIZE;
  const parts: Blob[] = [];
  let offset = 0;
  while (offset < file.size) {
    parts.push(file.slice(offset, offset + partSize));
    offset += partSize;
  }
  return parts;
}

/**
 * Convert a File to base64 string.
 */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const base64 = result.split(',')[1] || result;
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
