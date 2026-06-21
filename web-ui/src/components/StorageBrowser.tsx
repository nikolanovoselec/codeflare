import { Component, Show, onMount, onCleanup, createSignal, createMemo, createEffect } from 'solid-js';
import { storageStore } from '../stores/storage';
import { sessionStore } from '../stores/session';
import { getDownloadUrl } from '../api/storage';
import { extractFilesFromDrop } from '../lib/file-upload';
import { logger } from '../lib/logger';
import { ALWAYS_VISIBLE_SPECIAL_PREFIXES } from '../lib/special-folders';
import Button from './ui/Button';
import StorageBreadcrumbs from './storage/StorageBreadcrumbs';
import StorageToolbar from './storage/StorageToolbar';
import FileList from './storage/FileList';
import UploadQueue from './storage/UploadQueue';
import '../styles/storage-browser.css';

const StorageBrowser: Component = () => {
  const [isDragOver, setIsDragOver] = createSignal(false);
  // SEARCH UI DISABLED 2026-05-18 (sync-v2): the setter is unused at
  // runtime because the toolbar button that flipped it was removed.
  // Underscore prefix matches the project's oxlint convention for
  // intentionally-unused identifiers. To restore: rename back to
  // `setShowSearch` and re-add the toggle button in StorageToolbar.
  const [showSearch, _setShowSearch] = createSignal(false);
  const [searchQuery, setSearchQuery] = createSignal('');
  const [selectionModeEnabled, setSelectionModeEnabled] = createSignal(false);
  const [showHiddenItems, setShowHiddenItems] = createSignal(false);
  const workspaceSyncEnabled = createMemo(() => sessionStore.preferences.workspaceSyncEnabled === true);

  let searchInputRef: HTMLInputElement | undefined;

  onMount(() => {
    storageStore.browse(storageStore.currentPrefix || '');

    // Auto-refresh file listing every 30s (silent — no loading spinner)
    const refreshInterval = setInterval(() => {
      const hasActiveUploads = storageStore.uploads.some(
        (u) => u.status === 'uploading' || u.status === 'pending'
      );
      const hasSelections = storageStore.selectedKeys.length > 0 ||
                           storageStore.selectedPrefixes.length > 0;

      if (!hasActiveUploads && !hasSelections && !storageStore.loading) {
        void storageStore.refresh({ silent: true });
        void storageStore.fetchStats();
      }
    }, 30_000);

    onCleanup(() => clearInterval(refreshInterval));
  });

  const isHiddenPath = (path: string): boolean =>
    path.split('/').filter(Boolean).some((segment) => segment.startsWith('.'));

  const displayedItems = createMemo(() => {
    const q = searchQuery();
    const isSearching = !!q;
    const source = isSearching
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

    // Always-on special folders (Vault, Uploads, Temporary). These are
    // auto-created by the container entrypoint and bisynced unconditionally,
    // so they should appear in the storage panel even when R2 has no objects
    // under them yet (otherwise a brand-new user sees a confusing empty panel
    // and cannot tell whether the rows even exist). Skipped when the user is
    // searching: synthetic rows have no objects[] entries to match against
    // a query, so injecting them would falsely imply the search matched
    // them. At any other prefix the standard listing wins.
    if (storageStore.currentPrefix === '' && !isSearching) {
      const missing = ALWAYS_VISIBLE_SPECIAL_PREFIXES.filter(
        (p) => !workspaceFiltered.prefixes.includes(p),
      );
      if (missing.length > 0) {
        workspaceFiltered = {
          ...workspaceFiltered,
          prefixes: [...workspaceFiltered.prefixes, ...missing].sort(),
        };
      }
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

  // Which special-folder info tooltip is currently expanded (workspace/,
  // Vault/, Uploads/, Temporary/), or null. Single-tooltip state - opening a
  // second one closes the first, matching the prior workspace-only behaviour.
  const [openSpecialTooltip, setOpenSpecialTooltip] = createSignal<string | null>(null);
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

  // Returns true on success, false on caught failure. Callers in the
  // multi-select path use the return value to aggregate a single
  // user-visible summary rather than silently swallowing per-file errors.
  const triggerDownload = async (key: string): Promise<boolean> => {
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
      return true;
    } catch (e) {
      logger.error('[StorageBrowser] Download failed:', { key, error: e instanceof Error ? e.message : e });
      return false;
    }
  };

  const handleDownloadSelected = async () => {
    const keys = [...storageStore.selectedKeys];
    let failed = 0;
    for (const key of keys) {
      const ok = await triggerDownload(key);
      if (!ok) failed += 1;
    }
    if (failed > 0) {
      // No global toast component is wired up yet; the per-file logger.error
      // calls capture the detail and the alert surfaces the aggregate to the
      // user so a partial batch failure does not look like silent success.
      // eslint-disable-next-line no-alert
      globalThis.alert?.(`${failed} of ${keys.length} downloads failed. See browser console for details.`);
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
          // SEARCH UI DISABLED 2026-05-18 (REQ-STOR-015 + sync-v2 PR):
          // the search-toggle button was removed from StorageToolbar.
          // showSearch / setShowSearch / searchQuery / setSearchQuery /
          // handleSearchInput remain declared above, and the
          // <Show when={showSearch()}> render block below stays in
          // place. They are now latent (nothing flips showSearch to
          // true), and storageStore.searchFiles() is still callable
          // by anything that wants the filter chain. To restore: add
          // a button in StorageToolbar that calls setShowSearch and
          // re-add showSearch + setShowSearch to its props.
          showHiddenItems={showHiddenItems}
          setShowHiddenItems={setShowHiddenItems}
          selectionModeEnabled={selectionModeEnabled}
          toggleSelectionMode={toggleSelectionMode}
          selectedCount={selectedCount}
          onUploadClick={() => fileInputRef?.click()}
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

      {/* REQ-STOR-015: ephemeral notice for sync results that the user
          should see beyond a tooltip-on-hover. Only renders for the
          two non-trivial outcomes: no running sessions (the trigger
          was a no-op), and failures. Successful syncs stay silent
          because the listing refresh is the visible confirmation. The
          store auto-clears syncResult after SYNC_RESULT_DISPLAY_MS so
          the notice disappears on its own. */}
      <Show
        when={
          !storageStore.syncing &&
          storageStore.syncResult &&
          (storageStore.syncResult.total === 0 || storageStore.syncResult.failed > 0)
        }
      >
        <div
          class="storage-sync-notice"
          classList={{
            'storage-sync-notice--info': storageStore.syncResult?.total === 0,
            'storage-sync-notice--error': (storageStore.syncResult?.failed ?? 0) > 0,
          }}
          role="status"
          aria-live="polite"
        >
          {storageStore.syncResult?.total === 0
            ? 'No running sessions to sync. Start a session to push files to the container.'
            : `Sync failed on ${storageStore.syncResult?.failed} session${storageStore.syncResult?.failed === 1 ? '' : 's'}${
                storageStore.syncResult?.lastError ? `: ${storageStore.syncResult.lastError}` : '.'
              }`}
        </div>
      </Show>

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
          openSpecialTooltip={openSpecialTooltip}
          setOpenSpecialTooltip={setOpenSpecialTooltip}
          applySelection={applySelection}
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
