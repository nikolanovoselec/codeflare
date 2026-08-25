import { describe, expect, it, vi } from 'vitest';
import { createBrowserIdeWindowOpener } from '../../lib/browser-ide-window';

function browserWindow() {
  return {
    closed: false,
    opener: {},
    focus: vi.fn(),
  } as unknown as Window;
}

describe('browser IDE window ownership', () => {
  it('REQ-IDE-050 AC4: opens every explicit gesture synchronously', () => {
    const handle = browserWindow();
    let insideGesture = false;
    const openWindow = vi.fn((_url?: string | URL, _target?: string) => {
      expect(insideGesture).toBe(true);
      return handle;
    });
    const openBrowserIdeWindow = createBrowserIdeWindowOpener(openWindow);

    insideGesture = true;
    const result = openBrowserIdeWindow('abcdef0123456789');
    insideGesture = false;

    expect(result).toBe('opened');
    expect(openWindow).toHaveBeenCalledWith(
      '/api/vscode/abcdef0123456789/',
      'codeflare-vscode-abcdef0123456789',
    );
    expect(handle.opener).toBeNull();
  });

  it('REQ-IDE-050 AC2: focuses a live retained handle without navigation or a second open', () => {
    const retainedHandle = browserWindow();
    const openWindow = vi.fn().mockReturnValue(retainedHandle);
    const openBrowserIdeWindow = createBrowserIdeWindowOpener(openWindow);

    expect(openBrowserIdeWindow('abcdef0123456789')).toBe('opened');
    expect(openBrowserIdeWindow('abcdef0123456789')).toBe('focused');

    expect(openWindow).toHaveBeenCalledOnce();
    expect(retainedHandle.focus).toHaveBeenCalledTimes(2);
  });

  it('REQ-IDE-050 AC2: uses independent named targets and retained handles for different sessions', () => {
    const firstHandle = browserWindow();
    const secondHandle = browserWindow();
    const openWindow = vi.fn()
      .mockReturnValueOnce(firstHandle)
      .mockReturnValueOnce(secondHandle);
    const openBrowserIdeWindow = createBrowserIdeWindowOpener(openWindow);

    openBrowserIdeWindow('abcdef0123456789');
    openBrowserIdeWindow('fedcba9876543210');

    expect(openWindow.mock.calls.map((call) => call[1])).toEqual([
      'codeflare-vscode-abcdef0123456789',
      'codeflare-vscode-fedcba9876543210',
    ]);
    expect(firstHandle.focus).toHaveBeenCalledOnce();
    expect(secondHandle.focus).toHaveBeenCalledOnce();
  });

  it('rejects invalid session IDs before constructing a URL or target', () => {
    const openWindow = vi.fn(() => browserWindow());
    const openBrowserIdeWindow = createBrowserIdeWindowOpener(openWindow);

    for (const sessionId of ['', 'short', 'UPPERCASE', 'has/slash', 'x'.repeat(25)]) {
      expect(openBrowserIdeWindow(sessionId)).toBe('invalid-session');
    }
    expect(openWindow).not.toHaveBeenCalled();
  });

  it('REQ-IDE-050 AC3: reports a null window.open result as popup blocked', () => {
    const openWindow = vi.fn(() => null);
    const openBrowserIdeWindow = createBrowserIdeWindowOpener(openWindow);

    expect(openBrowserIdeWindow('abcdef0123456789')).toBe('blocked');
    expect(openWindow).toHaveBeenCalledOnce();
  });
});
