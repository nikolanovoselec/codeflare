const SESSION_ID_PATTERN = /^[a-z0-9]{8,24}$/;

export type BrowserIdeWindowResult = 'opened' | 'focused' | 'blocked' | 'invalid-session';

type OpenWindow = (url: string, target: string) => Window | null;

export function createBrowserIdeWindowOpener(
  openWindow: OpenWindow = (url, target) => window.open(url, target),
): (sessionId: string) => BrowserIdeWindowResult {
  const retainedWindows = new Map<string, Window>();

  return (sessionId) => {
    if (!SESSION_ID_PATTERN.test(sessionId)) return 'invalid-session';

    const retainedWindow = retainedWindows.get(sessionId);
    if (retainedWindow && !retainedWindow.closed) {
      retainedWindow.focus();
      return 'focused';
    }

    const openedWindow = openWindow(
      `/api/vscode/${sessionId}/`,
      `codeflare-vscode-${sessionId}`,
    );
    if (!openedWindow) return 'blocked';

    openedWindow.opener = null;
    retainedWindows.set(sessionId, openedWindow);
    openedWindow.focus();
    return 'opened';
  };
}
