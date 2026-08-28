import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { attachHerdrMouseInput } from '../../lib/herdr-mouse';

describe('Herdr SGR mouse input', () => {
  let screen: HTMLDivElement;
  let send: ReturnType<typeof vi.fn<(sequence: string) => void>>;
  let focus: ReturnType<typeof vi.fn>;
  let cleanup: () => void;

  beforeEach(() => {
    screen = document.createElement('div');
    document.body.appendChild(screen);
    vi.spyOn(screen, 'getBoundingClientRect').mockReturnValue({
      left: 10,
      top: 20,
      width: 100,
      height: 50,
      right: 110,
      bottom: 70,
      x: 10,
      y: 20,
      toJSON: () => ({}),
    });
    send = vi.fn<(sequence: string) => void>();
    focus = vi.fn();
    cleanup = attachHerdrMouseInput(
      screen,
      { cols: 10, rows: 5, focus } as unknown as Terminal,
      send,
    );
  });

  afterEach(() => {
    cleanup();
    screen.remove();
    vi.restoreAllMocks();
  });

  it('encodes physical and synthesized left clicks as SGR terminal input', () => {
    screen.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      clientX: 34,
      clientY: 34,
      button: 0,
      buttons: 1,
    }));
    screen.dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true,
      cancelable: true,
      clientX: 34,
      clientY: 34,
      button: 0,
      buttons: 0,
    }));

    expect(send).toHaveBeenNthCalledWith(1, '\x1b[<0;3;2M');
    expect(send).toHaveBeenNthCalledWith(2, '\x1b[<0;3;2m');
    expect(focus).toHaveBeenCalledOnce();
  });

  it('encodes held-button movement and ignores movement without an active press', () => {
    document.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      cancelable: true,
      clientX: 84,
      clientY: 59,
      buttons: 1,
      shiftKey: true,
    }));
    expect(send).not.toHaveBeenCalled();

    screen.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      clientX: 34,
      clientY: 34,
      button: 0,
      buttons: 1,
    }));
    document.dispatchEvent(new MouseEvent('mousemove', {
      bubbles: true,
      cancelable: true,
      clientX: 84,
      clientY: 59,
      buttons: 1,
      shiftKey: true,
    }));

    expect(send).toHaveBeenNthCalledWith(1, '\x1b[<0;3;2M');
    expect(send).toHaveBeenNthCalledWith(2, '\x1b[<36;8;4M');
  });

  it('encodes wheel navigation and modifier-aware right clicks', () => {
    screen.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      clientX: 109,
      clientY: 69,
      deltaY: 20,
    }));
    screen.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      clientX: 10,
      clientY: 20,
      button: 2,
      buttons: 2,
      ctrlKey: true,
    }));
    screen.dispatchEvent(new MouseEvent('mouseup', {
      bubbles: true,
      cancelable: true,
      clientX: 10,
      clientY: 20,
      button: 2,
      buttons: 0,
      ctrlKey: true,
    }));

    expect(send).toHaveBeenNthCalledWith(1, '\x1b[<65;10;5M');
    expect(send).toHaveBeenNthCalledWith(2, '\x1b[<18;1;1M');
    expect(send).toHaveBeenNthCalledWith(3, '\x1b[<18;1;1m');
  });

  it('stops owning input after cleanup', () => {
    cleanup();
    screen.dispatchEvent(new MouseEvent('mousedown', {
      bubbles: true,
      cancelable: true,
      clientX: 34,
      clientY: 34,
      button: 0,
      buttons: 1,
    }));

    expect(send).not.toHaveBeenCalled();
  });
});
