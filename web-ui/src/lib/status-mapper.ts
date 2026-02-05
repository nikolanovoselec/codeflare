import type { InitProgress, StartupStatusResponse } from '../types';

// Map startup status response to InitProgress format with real-time details
export function mapStartupDetailsToProgress(status: StartupStatusResponse): InitProgress {
  const details: { key: string; value: string; status?: 'ok' | 'error' | 'pending' }[] = [];
  if (status.details) {
    // Container status - dynamic
    const containerStatus = status.details.containerStatus || 'stopped';
    details.push({
      key: 'Container',
      value: containerStatus === 'running' || containerStatus === 'healthy' ? 'Running' : containerStatus,
      status: containerStatus === 'running' || containerStatus === 'healthy' ? 'ok' : 'pending',
    });

    // Sync status - dynamic
    const syncStatus = status.details.syncStatus || 'pending';
    let syncValue = syncStatus;
    let syncStatusIndicator: 'ok' | 'error' | 'pending' = 'pending';
    if (syncStatus === 'success') {
      syncValue = 'Synced';
      syncStatusIndicator = 'ok';
    } else if (syncStatus === 'failed') {
      syncValue = status.details.syncError || 'Failed';
      syncStatusIndicator = 'error';
    } else if (syncStatus === 'syncing') {
      syncValue = 'Syncing...';
      syncStatusIndicator = 'pending';
    } else if (syncStatus === 'skipped') {
      syncValue = 'Skipped';
      syncStatusIndicator = 'ok';
    } else {
      syncValue = 'Pending';
      syncStatusIndicator = 'pending';
    }
    details.push({
      key: 'Sync',
      value: syncValue,
      status: syncStatusIndicator,
    });

    // Terminal status - dynamic
    const terminalServerOk = status.details.terminalServerOk;
    let terminalValue = 'Starting';
    let terminalStatus: 'ok' | 'error' | 'pending' = 'pending';
    if (terminalServerOk) {
      terminalValue = 'Ready';
      terminalStatus = 'ok';
    } else if (status.details.healthServerOk) {
      terminalValue = 'Starting...';
      terminalStatus = 'pending';
    }
    details.push({
      key: 'Terminal',
      value: terminalValue,
      status: terminalStatus,
    });

    // User email
    if (status.details.email) {
      details.push({ key: 'User', value: status.details.email, status: 'ok' });
    }
  }

  return {
    stage: status.stage,
    progress: status.progress,
    message: status.message,
    details,
  };
}
