/**
 * Format relative time from a date.
 * Compact format: just now → 45s ago → 12m ago → 5h ago → 3d ago → 2w ago → Jan 15 → Jan 15, 2025
 */
export function formatRelativeTime(date: Date | undefined): string {
  if (!date) return '--';

  const now = Date.now();
  const diff = now - date.getTime();
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const weeks = Math.floor(days / 7);

  if (seconds < 10) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  if (days < 30) return `${weeks}w ago`;

  const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = monthNames[date.getMonth()];
  const day = date.getDate();

  if (date.getFullYear() === new Date(now).getFullYear()) {
    return `${month} ${day}`;
  }
  return `${month} ${day}, ${date.getFullYear()}`;
}

/**
 * Format a duration in seconds to a human-readable string.
 * 0 → "0s", 59 → "59s", 60 → "1m", 3600 → "1h 0m", 7260 → "2h 1m"
 */
export function formatDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (hours === 0) return `${minutes}m`;
  if (minutes === 0) return `${hours}h`;
  return `${hours}h ${minutes}m`;
}

function trimTrailingZero(value: number): string {
  const s = value.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${trimTrailingZero(bytes / 1024)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${trimTrailingZero(bytes / (1024 * 1024))} MB`;
  if (bytes < 1024 * 1024 * 1024 * 1024) return `${trimTrailingZero(bytes / (1024 * 1024 * 1024))} GB`;
  return `${trimTrailingZero(bytes / (1024 * 1024 * 1024 * 1024))} TB`;
}