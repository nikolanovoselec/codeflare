import { Component, For, Show, onMount } from 'solid-js';
import { storageStore } from '../../stores/storage';
import Button from '../ui/Button';

const UploadQueue: Component = () => {
  onMount(() => { void storageStore.refreshMultipartRecovery(); });
  return (
    <Show when={storageStore.uploads.length > 0}>
      <div class="storage-upload-queue" data-testid="storage-upload-queue">
        <For each={storageStore.uploads}>
          {(upload) => (
            <div>
              <div class="upload-item" classList={{ [`upload-item--${upload.status}`]: true }}>
                <span class="upload-item-name">{upload.fileName}</span>
                <div class="upload-item-progress">
                  <div class="upload-item-bar" style={{ width: `${upload.progress}%` }} />
                </div>
                <span class="upload-item-status">{upload.status}</span>
              </div>
              <Show when={upload.recovery}>
                {(recovery) => (
                  <div class="upload-item">
                    <span role="status">Upload completion could not be confirmed. Check whether the file is already present before aborting.</span>
                    <Button variant="danger" size="sm" loading={recovery().aborting} onClick={() => {
                      if (window.confirm(`Abort the unconfirmed upload for "${upload.fileName}"? Any remaining upload parts will be discarded.`)) {
                        void storageStore.abortUnconfirmedUpload(upload.id);
                      }
                    }}>Abort upload</Button>
                  </div>
                )}
              </Show>
              <Show when={upload.error}><span role="status">{upload.error}</span></Show>
            </div>
          )}
        </For>
      </div>
    </Show>
  );
};

export default UploadQueue;
