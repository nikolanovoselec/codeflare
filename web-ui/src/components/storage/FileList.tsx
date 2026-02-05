import { Component, For, Show, Accessor } from 'solid-js';
import { storageStore } from '../../stores/storage';
import { getFileIcon } from '../../lib/file-icons';
import { formatRelativeTime, formatSize } from '../../lib/format';
import Icon from '../Icon';
import { mdiTrainCarContainer } from '@mdi/js';

interface FileListProps {
  displayedItems: Accessor<{ objects: Array<{ key: string; size: number; lastModified: string }>; prefixes: string[] }>;
  isDragOver: Accessor<boolean>;
  selectionModeEnabled: Accessor<boolean>;
  selectedKeySet: Accessor<Set<string>>;
  selectedPrefixSet: Accessor<Set<string>>;
  workspaceTooltipVisible: Accessor<boolean>;
  setWorkspaceTooltipVisible: (v: boolean) => void;
  applySelection: (targetId: string, shiftKey: boolean) => void;
  triggerDownload: (key: string) => void;
  handleDragOver: (e: DragEvent) => void;
  handleDragLeave: (e: DragEvent) => void;
  handleDrop: (e: DragEvent) => void;
  handleFileDragStart: (key: string, e: DragEvent) => void;
}

const getFileName = (key: string): string => {
  const parts = key.split('/');
  return parts[parts.length - 1] || parts[parts.length - 2] || key;
};

const getFolderName = (prefix: string): string => {
  const parts = prefix.split('/').filter(Boolean);
  const name = parts[parts.length - 1] || prefix;
  return name === 'workspace' ? 'Workspace' : name;
};

const isWorkspaceFolder = (prefix: string): boolean =>
  prefix === 'workspace/';

const FileList: Component<FileListProps> = (props) => {
  return (
    <div
      class="storage-drop-zone"
      classList={{ 'storage-drop-zone--active': props.isDragOver() }}
      data-testid="storage-drop-zone"
      onDragOver={props.handleDragOver}
      onDragLeave={props.handleDragLeave}
      onDrop={props.handleDrop}
    >
      <For each={props.displayedItems().prefixes}>
        {(prefix) => {
          const rawName = prefix.split('/').filter(Boolean).pop() || prefix;
          const icon = getFileIcon(getFolderName(prefix), true);
          return (
            <div
              class="storage-item storage-item--folder"
              data-testid={`folder-${rawName}`}
              classList={{ 'storage-item--selected': props.selectedPrefixSet().has(prefix) }}
              onClick={(e) => {
                if (props.selectionModeEnabled()) {
                  props.applySelection(`p:${prefix}`, e.shiftKey);
                } else {
                  storageStore.navigateTo(prefix);
                }
              }}
            >
              <Show when={props.selectionModeEnabled()}>
                <input
                  type="checkbox"
                  class="storage-item-checkbox"
                  checked={props.selectedPrefixSet().has(prefix)}
                  onClick={(e) => {
                    e.stopPropagation();
                    props.applySelection(`p:${prefix}`, e.shiftKey);
                  }}
                />
              </Show>
              <span class="storage-item-icon-dot" style={{ "background-color": icon.color }} />
              <span class="storage-item-name">{getFolderName(prefix)}</span>
              <Show when={isWorkspaceFolder(prefix)}>
                <span
                  class="workspace-container-icon"
                  data-testid="workspace-container-icon"
                  onClick={(e) => {
                    e.stopPropagation();
                    props.setWorkspaceTooltipVisible(!props.workspaceTooltipVisible());
                  }}
                >
                  <Icon path={mdiTrainCarContainer} size={14} />
                </span>
                <Show when={props.workspaceTooltipVisible()}>
                  <span class="workspace-sync-tooltip">
                    Holds your codebase and other assets. Disabling sync in settings is recommended, clone your repositories fresh every session.
                  </span>
                </Show>
              </Show>
            </div>
          );
        }}
      </For>

      <For each={props.displayedItems().objects}>
        {(obj) => {
          const icon = getFileIcon(getFileName(obj.key));
          return (
            <div
              class="storage-item storage-item--file"
              data-testid={`file-${getFileName(obj.key)}`}
              classList={{ 'storage-item--selected': props.selectedKeySet().has(obj.key) }}
              draggable="true"
              onDragStart={(e) => props.handleFileDragStart(obj.key, e)}
            >
              <Show when={props.selectionModeEnabled()}>
                <input
                  type="checkbox"
                  class="storage-item-checkbox"
                  checked={props.selectedKeySet().has(obj.key)}
                  onClick={(e) => {
                    e.stopPropagation();
                    props.applySelection(`f:${obj.key}`, e.shiftKey);
                  }}
                />
              </Show>
              <span class="storage-item-icon-dot" style={{ "background-color": icon.color }} />
              <span
                class="storage-item-name"
                onClick={(e) => {
                  if (props.selectionModeEnabled()) {
                    props.applySelection(`f:${obj.key}`, e.shiftKey);
                  } else {
                    props.triggerDownload(obj.key);
                  }
                }}
              >
                {getFileName(obj.key)}
              </span>
              <span class="storage-item-size">{formatSize(obj.size)}</span>
              <span class="storage-item-modified">{formatRelativeTime(new Date(obj.lastModified))}</span>
            </div>
          );
        }}
      </For>

      <Show when={props.displayedItems().prefixes.length === 0 && props.displayedItems().objects.length === 0}>
        <div class="storage-empty" data-testid="storage-empty">
          <p>No files found. Drag and drop files here to upload.</p>
        </div>
      </Show>
    </div>
  );
};

export default FileList;
