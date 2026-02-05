import { Component } from 'solid-js';
import { mdiClose } from '@mdi/js';
import Icon from './Icon';
import StorageBrowser from './StorageBrowser';
import '../styles/storage-panel.css';

interface StoragePanelProps {
  isOpen: boolean;
  onClose: () => void;
}

const StoragePanel: Component<StoragePanelProps> = (props) => {
  // Handle Escape key to close panel
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape' && props.isOpen) {
      props.onClose();
    }
  };

  const handleBackdropClick = () => {
    props.onClose();
  };

  return (
    <>
      {/* Backdrop */}
      <div
        class={`storage-panel-backdrop ${props.isOpen ? 'open' : ''}`}
        onClick={handleBackdropClick}
        onKeyDown={handleKeyDown}
        data-testid="storage-panel-backdrop"
      />

      {/* Panel */}
      <aside
        class={`storage-panel ${props.isOpen ? 'open' : ''}`}
        data-testid="storage-panel"
        role="dialog"
        aria-label="Storage"
        aria-hidden={!props.isOpen}
      >
        {/* Header */}
        <header class="storage-panel-header">
          <h2 class="storage-panel-title">Storage</h2>
          <button
            type="button"
            class="storage-panel-close-button"
            onClick={() => props.onClose()}
            title="Close storage"
            data-testid="storage-panel-close-button"
          >
            <Icon path={mdiClose} size={20} />
          </button>
        </header>

        {/* Content */}
        <div class="storage-panel-content">
          <StorageBrowser />
          {/* TODO: Wire FilePreview to StorageBrowser file selection */}
        </div>
      </aside>
    </>
  );
};

export default StoragePanel;
