import { cleanup, fireEvent, render, screen } from '@solidjs/testing-library';
import { createSignal } from 'solid-js';
import { describe, expect, it, vi } from 'vitest';
import PiWorkspaceMode from '../../components/PiWorkspaceMode';
import type { PiSurface } from '../../types';

const name = 'Vibe — Chat';
const code = 'Code — Terminal';

describe('Pi workspace mode selector', () => {
  it.each(['segments', 'text', 'icon'] as const)('offers the same exclusive choices in %s form', async presentation => {
    const [value, change] = createSignal<PiSurface>('chat');
    render(() => <PiWorkspaceMode presentation={presentation} value={value()} onSelect={change} />);
    if (presentation !== 'segments') await fireEvent.click(screen.getByRole('button', { name: `Workspace mode: ${name}` }));
    expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'true');
    await fireEvent.click(screen.getByRole('button', { name: code }));
    if (presentation === 'segments') expect(screen.getByRole('button', { name: code })).toHaveAttribute('aria-pressed', 'true');
    else {
      const trigger = screen.getByRole('button', { name: `Workspace mode: ${code}` });
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
      expect(trigger).toHaveFocus();
    }
  });

  it('compacts a desktop selector when its header narrows and restores the segments when it expands', () => {
    let width = 800;
    let resize: () => void = () => {};
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(() => width);
    const scrollWidth = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(160);
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ width: 120 } as DOMRect);
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect() {}
    });
    try {
      render(() => <header><span>Codeflare</span><div class="header-spacer" />
        <PiWorkspaceMode fitContainer presentation="segments" value="chat" onSelect={() => {}} /><span>Profile</span>
      </header>);
      expect(screen.getByRole('group', { name: 'Workspace mode' })).toBeVisible();
      width = 320;
      resize();
      expect(screen.getByRole('button', { name: `Workspace mode: ${name}` })).toBeVisible();
      expect(screen.queryByRole('group', { name: 'Workspace mode' })).not.toBeInTheDocument();
      width = 800;
      resize();
      expect(screen.getByRole('group', { name: 'Workspace mode' })).toBeVisible();
    } finally {
      cleanup();
      clientWidth.mockRestore();
      scrollWidth.mockRestore();
      bounds.mockRestore();
      vi.unstubAllGlobals();
    }
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
