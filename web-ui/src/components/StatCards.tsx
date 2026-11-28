import { Component, Show } from 'solid-js';
import Icon from './Icon';
import { mdiFileDocumentOutline, mdiFolderOutline, mdiHarddisk, mdiCloudOutline } from '@mdi/js';
import { StatCard, StatCardMetric } from './StatCard';
import { storageStore } from '../stores/storage';
import { formatSize } from '../lib/format';

interface StorageStats {
  totalFiles: number;
  totalFolders: number;
  totalSizeBytes: number;
  bucketName?: string;
  maxStorageBytes?: number | null;
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
          <StatCard icon={mdiCloudOutline} testId="stat-card-storage"
            title={<span class="stat-card__title type-section-header">{formatBucketLabel(stats().bucketName)}</span>}>
            <div class="stat-card__metrics">
              <StatCardMetric testId="stat-card-files"
                label={<span class="stat-card__metric-label"><Icon path={mdiFileDocumentOutline} size={12} />Files</span>}
                value={<span class="stat-card__metric-value">{String(stats().totalFiles)}</span>} />
              <StatCardMetric testId="stat-card-folders"
                label={<span class="stat-card__metric-label"><Icon path={mdiFolderOutline} size={12} />Folders</span>}
                value={<span class="stat-card__metric-value">{String(stats().totalFolders)}</span>} />
              <StatCardMetric testId="stat-card-size"
                label={<span class="stat-card__metric-label"><Icon path={mdiHarddisk} size={12} />Storage</span>}
                value={<span class="stat-card__metric-value">
                  {formatSize(stats().totalSizeBytes)}
                  {stats().maxStorageBytes != null && stats().maxStorageBytes! > 0
                    ? ` / ${formatSize(stats().maxStorageBytes!)}`
                    : ''}
                </span>} />
            </div>
          </StatCard>
        )}
      </Show>
    </div>
  );
};

export default StatCards;
