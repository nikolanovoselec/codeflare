// REQ-MEM-001 AC3: capture the browser's IANA timezone via
// Intl.DateTimeFormat().resolvedOptions().timeZone and sync it to the
// user's preferences when it differs from the stored value. The
// container's capture pipeline reads USER_TIMEZONE from env on the
// next session start; this side-car sync keeps the backend's stored
// preference current as the user moves between locations.

export function getBrowserTimezone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return tz || null;
  } catch {
    return null;
  }
}

export interface SyncBrowserTimezoneInput {
  currentTimezone: string | undefined;
  browserTimezone: string | null;
  updatePreferences: (prefs: { userTimezone?: string }) => Promise<void>;
}

export async function syncBrowserTimezone(input: SyncBrowserTimezoneInput): Promise<void> {
  if (!input.browserTimezone) return;
  if (input.currentTimezone === input.browserTimezone) return;
  try {
    await input.updatePreferences({ userTimezone: input.browserTimezone });
  } catch (err) {
    // Best-effort sync; never block the caller (e.g. dashboard mount).
    // Log at warn so a persistent failure (auth, schema rejection) is
    // visible in devtools rather than silent (code-reviewer M1).
    // eslint-disable-next-line no-console
    console.warn('[timezone-sync] updatePreferences failed', err);
  }
}
