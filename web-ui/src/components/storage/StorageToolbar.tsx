import { Component, Show, Accessor } from 'solid-js';
import { storageStore } from '../../stores/storage';
import Icon from '../Icon';
import {
  mdiMagnify,
  mdiEyeOff,
  mdiSelect,
  mdiFolderPlus,
  mdiUpload,
  mdiSync,
  mdiDelete,
  mdiDownload,
} from '@mdi/js';

interface StorageToolbarProps {
  showSearch: Accessor<boolean>;
  setShowSearch: (v: boolean) => void;
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
  return (
    <div class="storage-actions">
      <button
        type="button"
        class="storage-icon-btn"
        data-testid="storage-search-toggle"
        title="Search"
        onClick={() => props.setShowSearch(!props.showSearch())}
      >
        <Icon path={mdiMagnify} size={16} />
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
