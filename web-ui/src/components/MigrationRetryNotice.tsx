import { createSignal, Show, type Component } from 'solid-js';
import { mdiClose } from '@mdi/js';
import Icon from './Icon';
import { retryBucketMigration } from '../api/client';
import { ApiError } from '../api/fetch-helper';
import { sessionStore } from '../stores/session';

export function createMigrationRetry() {
  const [migrationRetryPending, setMigrationRetryPending] = createSignal(false);
  const [migrationRetry, setMigrationRetry] = createSignal<{ haltedAt: string; error?: string }>();
  const [migrationNoticeDismissed, setMigrationNoticeDismissed] = createSignal(false);
  const currentMigrationRetry = () => {
    const retry = migrationRetry();
    return retry?.haltedAt === sessionStore.bucketMigrationHaltedAt ? retry : undefined;
  };
  const migrationRetryDisabled = () => {
    const retry = currentMigrationRetry();
    return migrationRetryPending() || Boolean(retry && !retry.error);
  };
  const currentMigrationRetryError = () => migrationNoticeDismissed() ? undefined : currentMigrationRetry()?.error;
  const migrationRetryStatus = () => {
    if (migrationRetryPending()) return 'Retrying migration';
    if (migrationNoticeDismissed()) return '';
    if (!migrationRetry()) return '';
    if (!sessionStore.bucketMigrationHaltedAt) {
      if (sessionStore.bucketMigrating) return 'Storage migration is running.';
      if (sessionStore.bucketMigrationPending) return 'Storage update pending. Close your running sessions to apply it.';
      return 'Storage is ready.';
    }
    const retry = currentMigrationRetry();
    return retry && !retry.error ? 'Retry accepted. Waiting for updated migration status.' : '';
  };
  const handleMigrationRetry = async () => {
    const haltedAt = sessionStore.bucketMigrationHaltedAt;
    if (!haltedAt || migrationRetryDisabled()) return;
    setMigrationRetryPending(true);
    setMigrationNoticeDismissed(false);
    setMigrationRetry(undefined);
    let errorMessage: string | undefined;
    try {
      try {
        await retryBucketMigration(haltedAt);
      } catch (error) {
        if (error instanceof ApiError && error.authRedirect) return;
        errorMessage = error instanceof ApiError && error.status === 409
          ? error.message : 'Could not confirm the retry. Check the migration status before trying again.';
      }
      setMigrationRetry({ haltedAt, error: errorMessage });
      void sessionStore.refreshSessionAncillaryStatus({ afterCurrent: true }).catch(() => undefined);
    } finally {
      setMigrationRetryPending(false);
    }
  };
  return {
    pending: migrationRetryPending,
    disabled: migrationRetryDisabled,
    status: migrationRetryStatus,
    error: currentMigrationRetryError,
    submit: handleMigrationRetry,
    dismiss: () => setMigrationNoticeDismissed(true),
  };
}

export type MigrationRetry = ReturnType<typeof createMigrationRetry>;

export const MigrationRetryNotice: Component<{ retry: MigrationRetry }> = (props) => {
  const hasNotice = () => Boolean(props.retry.status() || props.retry.error());
  return (
    <div class="dashboard-migration-retry-notice" classList={{ 'repository-restore-notice': hasNotice() }}>
      <div>
        <div role="status">{props.retry.status()}</div>
        <Show when={props.retry.error()}>
          {(message) => <div role="alert">{message()}</div>}
        </Show>
      </div>
      <Show when={hasNotice() && !props.retry.pending()}>
        <button type="button" aria-label="Dismiss migration notification" onClick={props.retry.dismiss}>
          <Icon path={mdiClose} size={18} aria-hidden="true" />
        </button>
      </Show>
    </div>
  );
};
