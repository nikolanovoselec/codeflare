import { Component, Show, onMount, onCleanup, createSignal, createMemo, createEffect } from 'solid-js';
import { storageStore } from '../stores/storage';
import { sessionStore } from '../stores/session';
import { getDownloadUrl } from '../api/storage';
import { extractFilesFromDrop } from '../lib/file-upload';
import { logger } from '../lib/logger';
import Button from './ui/Button';
import StorageBreadcrumbs from './storage/StorageBreadcrumbs';
import StorageToolbar from './storage/StorageToolbar';
import FileList from './storage/FileList';
import UploadQueue from './storage/UploadQueue';
import '../styles/storage-browser.css';

const StorageBrowser: Component = () => {
  const [isDragOver, setIsDragOver] = createSignal(false);
  const [showSearch, setShowSearch] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal('');
  const [selectionModeEnabled, setSelectionModeEnabled] = createSignal(false);
  const [showHiddenItems, setShowHiddenItems] = createSignal(false);
  const workspaceSyncEnabled = createMemo(() => sessionStore.preferences.workspaceSyncEnabled !== false);

  let searchInputRef: HTMLInputElement | undefined;

  onMount(() => {
    storageStore.browse('');

    // Auto-refresh file listing every 30s (silent — no loading spinner)
    const refreshInterval = setInterval(() => {
      const hasActiveUploads = storageStore.uploads.some(
        (u) => u.status === 'uploading' || u.status === 'pending'
      );
      const hasSelections = storageStore.selectedKeys.length > 0 ||
                           storageStore.selectedPrefixes.length > 0;

      if (!hasActiveUploads && !hasSelections && !storageStore.loading) {
        void storageStore.refresh({ silent: true });
      }
    }, 30_000);

    onCleanup(() => clearInterval(refreshInterval));
  });

  const isHiddenPath = (path: string): boolean =>
    path.split('/').filter(Boolean).some((segment) => segment.startsWith('.'));

  const displayedItems = createMemo(() => {
    const q = searchQuery();
    const source = q
      ? storageStore.searchFiles(q)
      : { objects: storageStore.objects, prefixes: storageStore.prefixes };

    let workspaceFiltered = workspaceSyncEnabled()
      ? source
      : {
        objects: source.objects.filter((obj) => !obj.key.startsWith('workspace/')),
        prefixes: source.prefixes.filter((prefix) => !prefix.startsWith('workspace/')),
      };

    // Always show "Workspace" folder at root level when sync is enabled
    if (workspaceSyncEnabled() && storageStore.currentPrefix === '' && !workspaceFiltered.prefixes.includes('workspace/')) {
      workspaceFiltered = {
        ...workspaceFiltered,
        prefixes: [...workspaceFiltered.prefixes, 'workspace/'].sort(),
      };
    }

    if (showHiddenItems()) {
      return workspaceFiltered;
    }

    return {
      objects: workspaceFiltered.objects.filter((obj) => !isHiddenPath(obj.key)),
      prefixes: workspaceFiltered.prefixes.filter((prefix) => !isHiddenPath(prefix)),
    };
  });

  createEffect(() => {
    if (!workspaceSyncEnabled() && storageStore.currentPrefix.startsWith('workspace/')) {
      void storageStore.navigateTo('');
    }
  });

  const [workspaceTooltipVisible, setWorkspaceTooltipVisible] = createSignal(false);
  const [lastSelectedId, setLastSelectedId] = createSignal<string | null>(null);
  const selectedKeySet = createMemo(() => new Set(storageStore.selectedKeys));
  const selectedPrefixSet = createMemo(() => new Set(storageStore.selectedPrefixes));

  const orderedIds = () => {
    const items = displayedItems();
    return [
      ...items.prefixes.map((p) => `p:${p}`),
      ...items.objects.map((o) => `f:${o.key}`),
    ];
  };

  const applySelection = (targetId: string, shiftKey: boolean) => {
    const lastId = lastSelectedId();
    if (!shiftKey || !lastId) {
      if (targetId.startsWith('p:')) {
        storageStore.toggleSelectPrefix(targetId.slice(2));
      } else {
        storageStore.toggleSelect(targetId.slice(2));
      }
      setLastSelectedId(targetId);
      return;
    }

    const ids = orderedIds();
    const start = ids.indexOf(lastId);
    const end = ids.indexOf(targetId);
    if (start === -1 || end === -1) {
      if (targetId.startsWith('p:')) {
        storageStore.toggleSelectPrefix(targetId.slice(2));
      } else {
        storageStore.toggleSelect(targetId.slice(2));
      }
      setLastSelectedId(targetId);
      return;
    }

    const [from, to] = start < end ? [start, end] : [end, start];
    const nextKeys = new Set(storageStore.selectedKeys);
    const nextPrefixes = new Set(storageStore.selectedPrefixes);
    for (const id of ids.slice(from, to + 1)) {
      if (id.startsWith('p:')) {
        nextPrefixes.add(id.slice(2));
      } else {
        nextKeys.add(id.slice(2));
      }
    }
    storageStore.setSelection([...nextKeys], [...nextPrefixes]);
    setLastSelectedId(targetId);
  };

  const selectedCount = () => storageStore.selectedKeys.length + storageStore.selectedPrefixes.length;

  const toggleSelectionMode = () => {
    const nextEnabled = !selectionModeEnabled();
    setSelectionModeEnabled(nextEnabled);
    if (!nextEnabled) {
      storageStore.clearSelection();
      setLastSelectedId(null);
    }
  };

  const handleDragOver = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  };

  const handleDragLeave = (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  };

  const handleDrop = async (e: DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
    if (e.dataTransfer) {
      const files = await extractFilesFromDrop(e.dataTransfer);
      if (files.length > 0) {
        await storageStore.uploadFiles(files, storageStore.currentPrefix);
      }
    }
  };

  const handleFileDragStart = (key: string, e: DragEvent) => {
    if (e.dataTransfer) {
      e.dataTransfer.setData('application/x-r2-key', key);
    }
  };

  const handleFileInputChange = async (e: Event) => {
    const input = e.target as HTMLInputElement;
    if (input.files) {
      const files = Array.from(input.files).map(f => ({
        file: f,
        relativePath: f.name,
      }));
      await storageStore.uploadFiles(files, storageStore.currentPrefix);
      input.value = '';
    }
  };

  const handleSearchInput = (e: Event) => {
    const value = (e.target as HTMLInputElement).value;
    setSearchQuery(value);
    storageStore.searchFiles(value);
  };

  const triggerDownload = async (key: string) => {
    try {
      const url = getDownloadUrl(key);
      const response = await fetch(url, { credentials: 'include' });
      if (!response.ok) {
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
    } catch (e) {
      logger.error('[StorageBrowser] Download failed:', { key, error: e instanceof Error ? e.message : e });
    }
  };

  const handleDownloadSelected = async () => {
    for (const key of storageStore.selectedKeys) {
      await triggerDownload(key);
    }
  };

  createEffect(() => {
    if (showSearch()) {
      requestAnimationFrame(() => {
        if (searchInputRef) {
          searchInputRef.focus();
          searchInputRef.select();
        }
      });
    }
  });

  let fileInputRef: HTMLInputElement | undefined;

  return (
    <div class="storage-browser" data-testid="storage-browser">
      <div class="storage-browser-header">
        <StorageBreadcrumbs currentPrefix={storageStore.currentPrefix} />
        <StorageToolbar
          showSearch={showSearch}
          setShowSearch={setShowSearch}
          showHiddenItems={showHiddenItems}
          setShowHiddenItems={setShowHiddenItems}
          selectionModeEnabled={selectionModeEnabled}
          toggleSelectionMode={toggleSelectionMode}
          selectedCount={selectedCount}
          fileInputRef={fileInputRef}
          onDeleteSelected={() => {
            storageStore.deleteSelected();
            setSelectionModeEnabled(false);
          }}
          onDownloadSelected={async () => {
            await handleDownloadSelected();
            setSelectionModeEnabled(false);
          }}
        />
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        style="display: none"
        onChange={handleFileInputChange}
      />

      <Show when={showSearch()}>
        <div class="storage-search-bar">
          <input
            ref={searchInputRef}
            type="text"
            class="storage-search-input"
            data-testid="storage-search-input"
            placeholder="Search files..."
            value={searchQuery()}
            onInput={handleSearchInput}
            autocomplete="off"
            autocorrect="off"
            autocapitalize="off"
            spellcheck={false}
          />
        </div>
      </Show>

      <Show when={storageStore.loading}>
        <div class="storage-loading" data-testid="storage-loading">
          <div class="storage-loading-spinner" />
          <span>Loading files...</span>
        </div>
      </Show>

      <Show when={storageStore.error}>
        <div class="storage-error" data-testid="storage-error">
          <p>{storageStore.error}</p>
          <Button variant="secondary" size="sm" onClick={() => storageStore.refresh()}>
            Retry
          </Button>
        </div>
      </Show>

      <Show when={!storageStore.loading && !storageStore.error}>
        <FileList
          displayedItems={displayedItems}
          isDragOver={isDragOver}
          selectionModeEnabled={selectionModeEnabled}
          selectedKeySet={selectedKeySet}
          selectedPrefixSet={selectedPrefixSet}
          workspaceTooltipVisible={workspaceTooltipVisible}
          setWorkspaceTooltipVisible={setWorkspaceTooltipVisible}
          applySelection={applySelection}
          triggerDownload={triggerDownload}
          handleDragOver={handleDragOver}
          handleDragLeave={handleDragLeave}
          handleDrop={handleDrop}
          handleFileDragStart={handleFileDragStart}
        />
      </Show>

      <UploadQueue />
    </div>
  );
};

export default StorageBrowser;
