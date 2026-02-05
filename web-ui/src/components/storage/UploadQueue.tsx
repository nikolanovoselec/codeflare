import { Component, For, Show } from 'solid-js';
import { storageStore } from '../../stores/storage';

const UploadQueue: Component = () => {
  return (
    <Show when={storageStore.uploads.length > 0}>
      <div class="storage-upload-queue" data-testid="storage-upload-queue">
        <For each={storageStore.uploads}>
          {(upload) => (
            <div class="upload-item" classList={{ [`upload-item--${upload.status}`]: true }}>
              <span class="upload-item-name">{upload.fileName}</span>
              <div class="upload-item-progress">
                <div class="upload-item-bar" style={{ width: `${upload.progress}%` }} />
              </div>
              <span class="upload-item-status">{upload.status}</span>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
};

export default UploadQueue;
