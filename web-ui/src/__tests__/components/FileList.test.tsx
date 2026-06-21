import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@solidjs/testing-library';
import type { ComponentProps } from 'solid-js';
import FileList from '../../components/storage/FileList';
import { getViewUrl } from '../../api/storage';

// REQ-STOR-016: file browser presentation — file-click opens a view tab; special
// folders surface their container path.

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

type Items = {
  objects: Array<{ key: string; size: number; lastModified: string }>;
  prefixes: string[];
};

function makeProps(items: Items): ComponentProps<typeof FileList> {
  return {
    displayedItems: () => items,
    isDragOver: () => false,
    selectionModeEnabled: () => false,
    selectedKeySet: () => new Set<string>(),
    selectedPrefixSet: () => new Set<string>(),
    openSpecialTooltip: () => null,
    setOpenSpecialTooltip: () => {},
    applySelection: () => {},
    handleDragOver: () => {},
    handleDragLeave: () => {},
    handleDrop: () => {},
    handleFileDragStart: () => {},
  };
}

describe('FileList — clicking a file opens it in a new tab (not download)', () => {
  it('calls window.open with the inline view URL and a new-tab target', () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    const key = 'docs/readme.md';

    const { container } = render(() => (
      <FileList {...makeProps({ objects: [{ key, size: 12, lastModified: '2026-01-01T00:00:00Z' }], prefixes: [] })} />
    ));

    const name = container.querySelector('.storage-item--file .storage-item-name') as HTMLElement;
    expect(name).toBeTruthy();
    fireEvent.click(name);

    expect(open).toHaveBeenCalledTimes(1);
    expect(open.mock.calls[0][0]).toBe(getViewUrl(key));
    expect(open.mock.calls[0][1]).toBe('_blank');
  });
});

describe('FileList — special folder surfaces its container path on the row', () => {
  it('renders the shortened ~/ container path for a special folder', () => {
    const { container } = render(() => (
      <FileList {...makeProps({ objects: [], prefixes: ['Vault/'] })} />
    ));

    const meta = container.querySelector('[data-testid="special-folder-path-vault"]') as HTMLElement;
    expect(meta).toBeTruthy();
    expect(meta.textContent?.trim()).toBe('~/Vault');
  });
});

describe('FileList — every folder surfaces its ~/ container path (REQ-STOR-016)', () => {
  it('renders ~/<prefix> for a regular root folder', () => {
    const { container } = render(() => (
      <FileList {...makeProps({ objects: [], prefixes: ['Documentation/'] })} />
    ));
    const meta = container.querySelector('[data-testid="folder-path-Documentation"]') as HTMLElement;
    expect(meta).toBeTruthy();
    expect(meta.textContent?.trim()).toBe('~/Documentation');
  });

  it('renders the full path for a nested subfolder (carries its whole prefix)', () => {
    const { container } = render(() => (
      <FileList {...makeProps({ objects: [], prefixes: ['Documentation/guides/'] })} />
    ));
    const meta = container.querySelector('[data-testid="folder-path-guides"]') as HTMLElement;
    expect(meta).toBeTruthy();
    expect(meta.textContent?.trim()).toBe('~/Documentation/guides');
  });

  it('renders the path for a dotfolder', () => {
    const { container } = render(() => (
      <FileList {...makeProps({ objects: [], prefixes: ['.claude/'] })} />
    ));
    const meta = container.querySelector('[data-testid="folder-path-.claude"]') as HTMLElement;
    expect(meta).toBeTruthy();
    expect(meta.textContent?.trim()).toBe('~/.claude');
  });

  it('does not render the generic path meta for a special folder (keeps its exact containerPath only)', () => {
    const { container } = render(() => (
      <FileList {...makeProps({ objects: [], prefixes: ['Vault/'] })} />
    ));
    expect(container.querySelector('[data-testid="folder-path-Vault"]')).toBeNull();
    expect(container.querySelector('[data-testid="special-folder-path-vault"]')).toBeTruthy();
  });
});
