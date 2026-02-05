import { Component, Show, For } from 'solid-js';
import '../styles/file-preview.css';

interface PreviewFile {
  key: string;
  type: 'text' | 'image' | 'binary';
  content?: string;
  url?: string;
  size: number;
  lastModified: string;
}

interface FilePreviewProps {
  file: PreviewFile | null;
  loading?: boolean;
  error?: string;
  onBack: () => void;
  onDownload: () => void;
}

function getFileName(key: string): string {
  const parts = key.split('/');
  return parts[parts.length - 1] || key;
}

const FilePreview: Component<FilePreviewProps> = (props) => {
  return (
    <div class="file-preview" data-testid="file-preview">
      <div class="file-preview-header">
        <button
          type="button"
          class="file-preview-back-btn"
          data-testid="file-preview-back"
          onClick={props.onBack}
        >
          Back
        </button>

        <Show when={props.file}>
          {(file) => (
            <span class="file-preview-filename" data-testid="file-preview-name">
              {getFileName(file().key)}
            </span>
          )}
        </Show>

        <Show when={props.file}>
          <button
            type="button"
            class="file-preview-download-btn"
            data-testid="file-preview-download"
            onClick={props.onDownload}
          >
            Download
          </button>
        </Show>
      </div>

      <Show when={props.loading}>
        <div class="file-preview-loading" data-testid="file-preview-loading">
          Loading preview...
        </div>
      </Show>

      <Show when={props.error}>
        {(error) => (
          <div class="file-preview-error" data-testid="file-preview-error">
            {error()}
          </div>
        )}
      </Show>

      <Show when={props.file?.type === 'text' && props.file}>
        {(file) => {
          const lines = () => (file().content ?? '').split('\n');
          return (
            <div class="file-preview-text">
              <div class="file-preview-line-numbers" data-testid="file-preview-line-numbers">
                <For each={lines()}>
                  {(_, i) => <div class="file-preview-line-number">{i() + 1}</div>}
                </For>
              </div>
              <pre class="file-preview-code" data-testid="file-preview-content">
                {file().content}
              </pre>
            </div>
          );
        }}
      </Show>

      <Show when={props.file?.type === 'image' && props.file}>
        {(file) => (
          <div class="file-preview-image-container">
            <img
              class="file-preview-img"
              data-testid="file-preview-image"
              src={file().url}
              alt={getFileName(file().key)}
            />
          </div>
        )}
      </Show>

      <Show when={props.file?.type === 'binary' && props.file}>
        <div class="file-preview-binary-info" data-testid="file-preview-binary">
          <p>Binary file - preview not available</p>
          <p class="file-preview-binary-size">
            Size: {props.file!.size.toLocaleString()} bytes
          </p>
        </div>
      </Show>
    </div>
  );
};

export default FilePreview;
