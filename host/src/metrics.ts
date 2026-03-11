/**
 * System metrics collection for the terminal server.
 *
 * Provides sync status, disk usage, and system metrics (CPU, memory)
 * for the /health endpoint.
 */

import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import type { Logger, SyncStatus, SystemMetrics, CachedDiskMetrics } from './types.js';

const execFileAsync = promisify(execFile);

/**
 * Read sync status from the file written by the rclone daemon.
 */
export function getSyncStatus(): SyncStatus {
  try {
    const data = fs.readFileSync('/tmp/sync-status.json', 'utf8');
    return JSON.parse(data) as SyncStatus;
  } catch {
    return { status: 'pending', error: null, userPath: null };
  }
}

// Cached disk metrics to avoid shelling out on every health check
let cachedDiskMetrics: CachedDiskMetrics = { value: '...', lastUpdated: 0 };
const DISK_CACHE_TTL = 30000; // 30 seconds

/**
 * Get disk usage for /home/user (cached for 30s).
 */
export async function getDiskMetrics(log: Logger): Promise<string> {
  if (Date.now() - cachedDiskMetrics.lastUpdated < DISK_CACHE_TTL) {
    return cachedDiskMetrics.value;
  }
  try {
    const { stdout } = await execFileAsync('df', ['-h', '/home/user']);
    const lines = stdout.trim().split('\n');
    if (lines.length >= 2) {
      const fields = lines[1].split(/\s+/);
      cachedDiskMetrics = { value: `${fields[2]}/${fields[1]}`, lastUpdated: Date.now() };
    }
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    log('debug', 'Disk metrics fetch failed', { error: message });
  }
  return cachedDiskMetrics.value;
}

/**
 * Get system metrics: CPU load, memory usage, and disk usage.
 */
export async function getSystemMetrics(log: Logger): Promise<SystemMetrics> {
  const metrics = { cpu: '...', mem: '...', hdd: '...' };
  try {
    const loadAvg = os.loadavg()[0];
    const cpus = os.cpus().length;
    metrics.cpu = ((loadAvg / cpus) * 100).toFixed(0) + '%';
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    log('debug', 'CPU metrics fetch failed', { error: message });
  }
  try {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const usedGB = (usedMem / 1024 / 1024 / 1024).toFixed(1);
    const totalGB = (totalMem / 1024 / 1024 / 1024).toFixed(1);
    metrics.mem = usedGB + '/' + totalGB + 'G';
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    log('debug', 'Memory metrics fetch failed', { error: message });
  }
  metrics.hdd = await getDiskMetrics(log);
  return metrics;
}
