import { Component, For, Show, Accessor } from 'solid-js';
import { storageStore } from '../../stores/storage';
import { getFileIcon } from '../../lib/file-icons';
import { formatRelativeTime, formatSize } from '../../lib/format';
import { isTouchDevice } from '../../lib/mobile';
import Icon from '../Icon';
import { mdiTrainCarContainer } from '@mdi/js';
import { SpecialFolder, getSpecialFolder } from '../../lib/special-folders';
import { getViewUrl } from '../../api/storage';

interface FileListProps {
  displayedItems: Accessor<{ objects: Array<{ key: string; size: number; lastModified: string }>; prefixes: string[] }>;
  isDragOver: Accessor<boolean>;
  selectionModeEnabled: Accessor<boolean>;
  selectedKeySet: Accessor<Set<string>>;
  selectedPrefixSet: Accessor<Set<string>>;
  // Which special-folder tooltip is currently expanded, keyed by prefix
  // (e.g. 'workspace/'). null means none. One tooltip at a time.
  openSpecialTooltip: Accessor<string | null>;
  setOpenSpecialTooltip: (prefix: string | null) => void;
  applySelection: (targetId: string, shiftKey: boolean) => void;
  handleDragOver: (e: DragEvent) => void;
  handleDragLeave: (e: DragEvent) => void;
  handleDrop: (e: DragEvent) => void;
  handleFileDragStart: (key: string, e: DragEvent) => void;
}

const getFileName = (key: string): string => {
  // Strip empty path segments (handles leading/trailing/double slashes)
  // and return the last surviving segment. Falls back to the raw key for
  // pathological inputs like '' or '/'.
  const parts = key.split('/').filter(Boolean);
  return parts[parts.length - 1] || key;
};

// Render obj.lastModified as a human-relative string. The Storage panel
// types lastModified as `string` but does not guarantee a parseable value
// at the type boundary; a corrupted R2 response or a synthetic row added
// elsewhere in the future could feed an empty value. `new Date('')`
// returns Invalid Date, which would otherwise render as 'NaN' in the UI.
// Returns '' for unrenderable timestamps.
const formatLastModified = (raw: string): string => {
  if (!raw) return '';
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return '';
  return formatRelativeTime(d);
};

const getFolderName = (prefix: string): string => {
  const special = getSpecialFolder(prefix);
  if (special) return special.label;
  const parts = prefix.split('/').filter(Boolean);
  return parts[parts.length - 1] || prefix;
};

// Display form of a special folder's in-container path: /home/user/Vault → ~/Vault.
const shortContainerPath = (path: string): string => path.replace(/^\/home\/user\//, '~/');

// Every folder maps to a real in-container directory: the R2 bucket bisyncs to the
// home root, so a folder's container path is just ~/<prefix>. Works at any depth
// (subfolders carry their full prefix) and for dotfolders (~/.claude/...). Special
// folders keep their exact containerPath instead (its case can differ, e.g. the
// R2 prefix workspace/ materialises at ~/Workspace).
const folderShortPath = (prefix: string): string => `~/${prefix.replace(/\/+$/, '')}`;

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
          const special = getSpecialFolder(prefix);
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
              <span class="storage-item-icon-dot" />
              <span class="storage-item-name">{getFolderName(prefix)}</span>
              <Show when={special} keyed>
                {(sf: SpecialFolder) => (
                  <>
                    <span
                      class="workspace-container-icon"
                      data-testid={`special-folder-icon-${sf.id}`}
                      title={`About ${sf.label}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        props.setOpenSpecialTooltip(
                          props.openSpecialTooltip() === prefix ? null : prefix,
                        );
                      }}
                    >
                      <Icon path={mdiTrainCarContainer} size={14} />
                    </span>
                    <Show when={props.openSpecialTooltip() === prefix}>
                      <span
                        class="workspace-sync-tooltip"
                        data-testid={`special-folder-tooltip-${sf.id}`}
                      >
                        {sf.description}
                        <span class="workspace-sync-tooltip-path">
                          Container path: <code>{sf.containerPath}</code>
                        </span>
                      </span>
                    </Show>
                  </>
                )}
              </Show>
              <span
                class="storage-item-folder-meta"
                data-testid={
                  special ? `special-folder-path-${special.id}` : `folder-path-${rawName}`
                }
              >
                {special ? shortContainerPath(special.containerPath) : folderShortPath(prefix)}
              </span>
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
                    // Open the file inline in a new browser tab (view) instead of
                    // forcing a download. The view URL serves it with an XSS-safe
                    // Content-Type + nosniff (src/routes/storage/download.ts).
                    window.open(getViewUrl(obj.key), '_blank', 'noopener,noreferrer');
                  }
                }}
              >
                {getFileName(obj.key)}
              </span>
              <span class="storage-item-size">{formatSize(obj.size)}</span>
              <span class="storage-item-modified">{formatLastModified(obj.lastModified)}</span>
            </div>
          );
        }}
      </For>

      <Show when={props.displayedItems().prefixes.length === 0 && props.displayedItems().objects.length === 0}>
        <div class="storage-empty" data-testid="storage-empty">
          <p>{isTouchDevice()
            ? 'No files found. Use the upload button to add files.'
            : 'No files found. Drag and drop files here to upload.'
          }</p>
        </div>
      </Show>
    </div>
  );
};

export default FileList;
