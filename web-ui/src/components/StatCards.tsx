import { Component, Show } from 'solid-js';
import Icon from './Icon';
import { mdiFileDocumentOutline, mdiFolderOutline, mdiHarddisk, mdiCloudOutline } from '@mdi/js';
import { storageStore } from '../stores/storage';
import '../styles/stat-cards.css';

interface StorageStats {
  totalFiles: number;
  totalFolders: number;
  totalSizeBytes: number;
  bucketName?: string;
}

interface StatCardsProps {
  stats: StorageStats | null;
}

function formatBucketLabel(bucketName?: string): string {
  if (!bucketName) return 'R2 Storage';
  const prefix = `${storageStore.workerName}-`;
  const label = bucketName.startsWith(prefix) ? bucketName.slice(prefix.length) : bucketName;
  return label.toUpperCase();
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  if (i === 0) return `${bytes} B`;
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${units[i]}`;
}

const StatCards: Component<StatCardsProps> = (props) => {
  return (
    <div class="stat-cards" data-testid="stat-cards">
      <Show
        when={props.stats}
        fallback={
          <div class="stat-card stat-card--skeleton" data-testid="stat-card-skeleton-0">
            <div class="stat-card__header">
              <div class="stat-card__skeleton-icon" />
              <div class="stat-card__skeleton-label" />
            </div>
            <div class="stat-card__metrics">
              <div class="stat-card__skeleton-value" />
              <div class="stat-card__skeleton-value" />
              <div class="stat-card__skeleton-value" />
            </div>
          </div>
        }
      >
        {(stats) => (
          <div class="stat-card" data-testid="stat-card-storage">
            <div class="stat-card__header">
              <Icon path={mdiCloudOutline} size={14} class="stat-card__icon" />
              <span class="stat-card__title">{formatBucketLabel(stats().bucketName)}</span>
            </div>
            <div class="stat-card__metrics">
              <div class="stat-card__metric" data-testid="stat-card-files">
                <span class="stat-card__metric-label">
                  <Icon path={mdiFileDocumentOutline} size={12} />
                  Files
                </span>
                <span class="stat-card__metric-value">{String(stats().totalFiles)}</span>
              </div>
              <div class="stat-card__metric" data-testid="stat-card-folders">
                <span class="stat-card__metric-label">
                  <Icon path={mdiFolderOutline} size={12} />
                  Folders
                </span>
                <span class="stat-card__metric-value">{String(stats().totalFolders)}</span>
              </div>
              <div class="stat-card__metric" data-testid="stat-card-size">
                <span class="stat-card__metric-label">
                  <Icon path={mdiHarddisk} size={12} />
                  Storage
                </span>
                <span class="stat-card__metric-value">{formatBytes(stats().totalSizeBytes)}</span>
              </div>
            </div>
          </div>
        )}
      </Show>
    </div>
  );
};

export default StatCards;
