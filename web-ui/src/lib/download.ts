import { getDownloadUrl } from '../api/storage';
import { logger } from './logger';

export type DownloadResult = 'ok' | 'blocked' | 'failed';

/**
 * A 403 carrying `{ code: 'DOWNLOADS_DISABLED' }` is view-only storage
 * (REQ-ENTERPRISE-019), not a transport failure — the caller shows the friendly
 * "disabled by your administrator" notice instead of a raw error.
 */
async function isDownloadsDisabledResponse(response: Response): Promise<boolean> {
  try {
    const body = (await response.clone().json()) as { code?: string };
    return body?.code === 'DOWNLOADS_DISABLED';
  } catch {
    return false;
  }
}

/**
 * Fetch a storage object and trigger a browser download.
 *
 * Returns:
 *  - `'ok'`      — the file downloaded;
 *  - `'blocked'` — the server returned a DOWNLOADS_DISABLED 403 (view-only storage),
 *                  so the caller surfaces the friendly notice — never a raw failure,
 *                  even when the client's cached `downloadsDisabled` flag was stale;
 *  - `'failed'`  — a genuine transport/HTTP error (the caller may aggregate these).
 *
 * Fetching (not anchor navigation) is what lets us read the 403 body and distinguish
 * a policy block from a real failure.
 */
export async function downloadFile(key: string): Promise<DownloadResult> {
  try {
    const response = await fetch(getDownloadUrl(key), { credentials: 'include' });
    if (!response.ok) {
      if (response.status === 403 && (await isDownloadsDisabledResponse(response))) {
        return 'blocked';
      }
      throw new Error(`Download failed: ${response.status} ${response.statusText}`);
    }
    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = key.split('/').pop() || 'download';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(blobUrl);
    return 'ok';
  } catch (e) {
    logger.error('[download] failed:', { key, error: e instanceof Error ? e.message : e });
    return 'failed';
  }
}
