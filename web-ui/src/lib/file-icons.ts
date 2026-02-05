type FileIcon = { color: string; label: string };

const EXTENSION_MAP: Record<string, FileIcon> = {
  '.ts': { color: '#3178c6', label: 'TypeScript' },
  '.tsx': { color: '#3178c6', label: 'TypeScript' },
  '.js': { color: '#f7df1e', label: 'JavaScript' },
  '.jsx': { color: '#f7df1e', label: 'JavaScript' },
  '.json': { color: '#f59e0b', label: 'JSON' },
  '.md': { color: '#6b7280', label: 'Markdown' },
  '.css': { color: '#3b82f6', label: 'CSS' },
  '.html': { color: '#e34f26', label: 'HTML' },
  '.py': { color: '#3572a5', label: 'Python' },
  '.go': { color: '#00add8', label: 'Go' },
};

const DEFAULT_ICON: FileIcon = { color: '#9ca3af', label: 'File' };
const FOLDER_ICON: FileIcon = { color: '#3b82f6', label: 'Folder' };

export function getFileIcon(filename: string, isFolder?: boolean): FileIcon {
  if (isFolder) return FOLDER_ICON;

  const basename = filename.includes('/') ? filename.split('/').pop()! : filename;
  const dotIndex = basename.lastIndexOf('.');
  if (dotIndex <= 0) return DEFAULT_ICON;

  const ext = basename.slice(dotIndex).toLowerCase();
  return EXTENSION_MAP[ext] ?? DEFAULT_ICON;
}
