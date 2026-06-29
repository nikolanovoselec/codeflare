import { Component, Show, onMount, onCleanup } from 'solid-js';
import { mdiCloudLockOutline } from '@mdi/js';
import Icon from './Icon';
import { storageStore } from '../stores/storage';
import '../styles/downloads-disabled-popup.css';

/**
 * REQ-ENTERPRISE-019: view-only storage. When downloads are disabled by the
 * deployment administrator, download controls render disabled and any interaction
 * opens this notice instead of triggering the server-side 403. The 403 in
 * src/routes/storage/download.ts remains the actual enforcement; this popup exists
 * so a normal user action never surfaces a raw error that "looks broken".
 */
const DownloadsDisabledPopup: Component = () => {
  const close = () => storageStore.dismissDownloadsNotice();

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && storageStore.downloadsNoticeOpen) close();
  };

  onMount(() => document.addEventListener('keydown', handleKeyDown));
  onCleanup(() => document.removeEventListener('keydown', handleKeyDown));

  return (
    <Show when={storageStore.downloadsNoticeOpen}>
      <div class="ddp-backdrop" data-testid="downloads-disabled-backdrop" onClick={close} />
      <div
        class="downloads-disabled-popup"
        data-testid="downloads-disabled-popup"
        role="alertdialog"
        aria-label="Downloads disabled"
      >
        <div class="ddp-header">
          <Icon path={mdiCloudLockOutline} size={20} class="ddp-icon" />
          <span class="ddp-title">Downloads disabled</span>
        </div>
        <p class="ddp-body">
          Downloading files is disabled by your administrator. You can still open and
          view files in the browser.
        </p>
        <button
          type="button"
          class="ddp-dismiss-btn"
          data-testid="downloads-disabled-dismiss"
          onClick={close}
        >
          Got it
        </button>
      </div>
    </Show>
  );
};

export default DownloadsDisabledPopup;
