export type NormalView = 'chat' | 'terminal' | 'vscode';

const NORMAL_VIEW_KEY = 'codeflare:normal-view';

/** Browser-local presentation only; never a session stamp or backend preference. */
export function readNormalView(editorAvailable: boolean): NormalView {
  try {
    const value = localStorage.getItem(NORMAL_VIEW_KEY);
    if (value === 'chat' || value === 'terminal' || value === 'vscode' && editorAvailable) return value;
  } catch {
    // Denied storage must not prevent entry into the usable default.
  }
  return 'chat';
}

export function rememberNormalView(view: NormalView): void {
  try { localStorage.setItem(NORMAL_VIEW_KEY, view); } catch {
    // The current session remains usable without persistent browser storage.
  }
}
