import { Component, Show, Accessor } from 'solid-js';
import { storageStore } from '../../stores/storage';
import Icon from '../Icon';
import {
  // SEARCH UI DISABLED 2026-05-18 (REQ-STOR-015 + sync-v2 PR):
  // the search-toggle button gave its toolbar slot to the Sync-now
  // (mdiCloudDownload) action. The store's searchFiles() helper
  // and the <Show when={showSearch()}> render block in
  // StorageBrowser.tsx are intentionally preserved so search can be
  // re-enabled by re-adding the toggle button below and re-importing
  // mdiMagnify.
  // mdiMagnify,
  mdiCloudDownload,
  mdiEyeOff,
  mdiSelect,
  mdiFolderPlus,
  mdiUpload,
  mdiSync,
  mdiDelete,
  mdiDownload,
} from '@mdi/js';

interface StorageToolbarProps {
  showHiddenItems: Accessor<boolean>;
  setShowHiddenItems: (v: boolean) => void;
  selectionModeEnabled: Accessor<boolean>;
  toggleSelectionMode: () => void;
  selectedCount: Accessor<number>;
  onUploadClick: () => void;
  onDeleteSelected: () => void;
  onDownloadSelected: () => Promise<void>;
}

const StorageToolbar: Component<StorageToolbarProps> = (props) => {
  const syncTooltip = () => {
    if (storageStore.syncing) {
      const r = storageStore.syncResult;
      return r && r.total > 0
        ? `Syncing ${r.triggered} of ${r.total} session${r.total === 1 ? '' : 's'}...`
        : 'Syncing all running sessions...';
    }
    const r = storageStore.syncResult;
    if (r) {
      if (r.failed > 0) return `Sync errors: ${r.lastError ?? `${r.failed} failed`}`;
      if (r.total === 0) return 'No running sessions to sync';
      return `Synced ${r.triggered} session${r.triggered === 1 ? '' : 's'}`;
    }
    return 'Sync all running sessions to R2 and refresh listing';
  };

  return (
    <div class="storage-actions">
      {/* REQ-STOR-015 AC1+AC6: Sync-now button replaces the search
          toggle in this slot. Click fans out a bisync trigger to all
          the user's running sessions, then silently re-lists R2.
          Disabled while a fan-out is in flight (storageStore.syncing). */}
      <button
        type="button"
        class="storage-icon-btn"
        data-testid="storage-sync-now-btn"
        title={syncTooltip()}
        disabled={storageStore.syncing}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void storageStore.syncNow();
        }}
      >
        <Icon
          path={mdiCloudDownload}
          size={16}
          class={storageStore.syncing ? 'storage-sync-breathing' : ''}
        />
      </button>
      <div class="storage-toolbar-separator" />
      <button
        type="button"
        class="storage-icon-btn"
        classList={{ 'storage-icon-btn--active': props.showHiddenItems() }}
        data-testid="storage-hidden-toggle"
        title={props.showHiddenItems() ? 'Hide Hidden Items' : 'Show Hidden Items'}
        onClick={() => props.setShowHiddenItems(!props.showHiddenItems())}
      >
        <Icon path={mdiEyeOff} size={16} />
      </button>
      <button
        type="button"
        class="storage-icon-btn"
        classList={{ 'storage-icon-btn--active': props.selectionModeEnabled() }}
        title="Selection mode"
        onClick={props.toggleSelectionMode}
      >
        <Icon path={mdiSelect} size={16} />
      </button>
      <div class="storage-toolbar-separator" />
      <button
        type="button"
        class="storage-icon-btn"
        title="New Folder"
        onClick={() => {
          const name = prompt('Folder name:');
          if (name?.trim()) storageStore.createFolder(name.trim());
        }}
      >
        <Icon path={mdiFolderPlus} size={16} />
      </button>
      <button
        type="button"
        class="storage-icon-btn"
        title="Upload"
        onClick={() => props.onUploadClick()}
      >
        <Icon path={mdiUpload} size={16} />
      </button>
      <button
        type="button"
        class="storage-icon-btn"
        data-testid="storage-sync-btn"
        title="Refresh"
        disabled={storageStore.loading}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          void storageStore.browse();
        }}
      >
        <Icon path={mdiSync} size={16} class={storageStore.loading ? 'storage-sync-spinning' : ''} />
      </button>
      <Show when={props.selectionModeEnabled() && props.selectedCount() > 0}>
        <button
          type="button"
          class="storage-action-btn storage-action-btn--delete"
          title="Delete selected"
          onClick={props.onDeleteSelected}
        >
          <Icon path={mdiDelete} size={14} />
          <span>{props.selectedCount()}</span>
        </button>
        <button
          type="button"
          class="storage-action-btn storage-action-btn--download"
          title="Download selected"
          onClick={async () => {
            await props.onDownloadSelected();
          }}
          disabled={storageStore.selectedKeys.length === 0}
        >
          <Icon path={mdiDownload} size={14} />
          <span>{storageStore.selectedKeys.length}</span>
        </button>
      </Show>
    </div>
  );
};

export default StorageToolbar;
