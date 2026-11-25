import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import PiWorkspaceMode from '../../components/PiWorkspaceMode';
import type { PiSurface } from '../../types';

const name = 'Vibe — Chat';
const code = 'Code — Terminal';

async function withMeasuredHeader(check: (fixture: {
  narrow: (width: number) => void;
  trigger: (mode: string) => HTMLElement;
}) => Promise<void>) {
  let width = 800;
  let resize = () => {};
  const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
  const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    return { width: this.textContent === 'Code · Terminal' ? 160 : this.textContent === 'Vibe · Chat' ? 132 : 120 } as DOMRect;
  });
  const rects = vi.spyOn(HTMLElement.prototype, 'getClientRects').mockImplementation(function (this: HTMLElement) {
    const rect = this.getBoundingClientRect();
    return { 0: rect, length: 1, item: () => rect };
  });
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect() {}
  });
  const [value, change] = createSignal<PiSurface>('terminal');
  try {
    render(() => <header><span>Codeflare</span><div class="header-spacer" />
      <div class="header-actions" style={{ 'column-gap': '8px' }}>
        <PiWorkspaceMode fitContainer value={value()} onSelect={change} /><button>Profile</button>
      </div>
    </header>);
    // Both the labeled trigger and its measurement use the mode's real text.
    await check({ narrow: next => { width = next; resize(); },
      trigger: mode => screen.getByRole('button', { name: `Workspace mode: ${mode}` }) });
  } finally {
    cleanup();
    clientWidth.mockRestore();
    bounds.mockRestore();
    rects.mockRestore();
    vi.unstubAllGlobals();
  }
}

describe('Pi workspace mode selector', () => {
  it.each(['text', 'icon'] as const)('offers the same exclusive choices in %s form', async presentation => {
    const [value, change] = createSignal<PiSurface>('chat');
    render(() => <PiWorkspaceMode presentation={presentation} value={value()} onSelect={change} />);
    await fireEvent.click(screen.getByRole('button', { name: `Workspace mode: ${name}` }));
    expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'true');
    await fireEvent.click(screen.getByRole('button', { name: code }));
    const trigger = screen.getByRole('button', { name: `Workspace mode: ${code}` });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(trigger).toHaveFocus();
  });

  it('compacts a desktop selector when Profile leaves too little room and restores it when the header expands', async () => {
    await withMeasuredHeader(async ({ narrow, trigger }) => {
      expect(trigger(code)).toHaveTextContent('Code · Terminal');
      narrow(448); // Profile and its gap leave 156px; without the gap Code would fit.
      expect(trigger(code)).not.toHaveTextContent('Code · Terminal');
      narrow(800);
      expect(trigger(code)).toHaveTextContent('Code · Terminal');
    });
  });

  it('restores the shorter Vibe label after switching modes without resizing the header', async () => {
    await withMeasuredHeader(async ({ narrow, trigger }) => {
      narrow(440); // 148px fits Vibe (132px), not Code (160px).
      expect(trigger(code)).not.toHaveTextContent('Code · Terminal');
      await fireEvent.click(trigger(code));
      await fireEvent.click(screen.getByRole('button', { name }));
      expect(trigger(name)).toHaveTextContent('Vibe · Chat');
      expect(trigger(name)).toHaveFocus();
    });
  });

  it('opens outside the header clipping boundary, focuses the current choice and restores focus on overlay dismissal', async () => {
    render(() => <header aria-label="Workspace header">
      <PiWorkspaceMode presentation="icon" value="chat" onSelect={() => {}} />
    </header>);
    const trigger = screen.getByRole('button', { name: `Workspace mode: ${name}` });
    await fireEvent.click(trigger);
    const popup = screen.getByRole('group', { name: 'Workspace mode options' });
    expect(screen.getByRole('banner', { name: 'Workspace header' })).not.toContainElement(popup);
    expect(screen.getByRole('button', { name })).toHaveFocus();
    await fireEvent.click(screen.getByTestId('workspace-mode-overlay'));
    expect(popup).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it('dismisses the compact picker on Escape and restores the trigger focus', async () => {
    render(() => <PiWorkspaceMode presentation="icon" value="chat" onSelect={() => {}} />);
    const trigger = screen.getByRole('button', { name: `Workspace mode: ${name}` });
    await fireEvent.click(trigger);
    const option = screen.getByRole('button', { name: code });
    option.focus();
    await fireEvent.keyDown(option, { key: 'Escape' });
    expect(screen.queryByRole('button', { name: code })).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });
});
