/**
 * System metrics collection for the terminal server.
 *
 * Provides sync status, disk usage, and system metrics (CPU, memory)
 * for the /health endpoint.
 */

import fs from 'fs';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

/**
 * Read sync status from the file written by the rclone daemon.
 * @returns {{ status: string, error: string|null, userPath: string|null }}
 */
export function getSyncStatus() {
  try {
    const data = fs.readFileSync('/tmp/sync-status.json', 'utf8');
    return JSON.parse(data);
  } catch (e) {
    return { status: 'pending', error: null, userPath: null };
  }
}

// Cached disk metrics to avoid shelling out on every health check
let cachedDiskMetrics = { value: '...', lastUpdated: 0 };
const DISK_CACHE_TTL = 30000; // 30 seconds

/**
 * Get disk usage for /home/user (cached for 30s).
 * @param {function} log - Structured logger
 * @returns {Promise<string>}
 */
export async function getDiskMetrics(log) {
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
  } catch (e) { log('debug', 'Disk metrics fetch failed', { error: e.message }); }
  return cachedDiskMetrics.value;
}

/**
 * Get system metrics: CPU load, memory usage, and disk usage.
 * @param {function} log - Structured logger
 * @returns {Promise<{ cpu: string, mem: string, hdd: string }>}
 */
export async function getSystemMetrics(log) {
  const metrics = { cpu: '...', mem: '...', hdd: '...' };
  try {
    const loadAvg = os.loadavg()[0];
    const cpus = os.cpus().length;
    metrics.cpu = ((loadAvg / cpus) * 100).toFixed(0) + '%';
  } catch (e) { log('debug', 'CPU metrics fetch failed', { error: e.message }); }
  try {
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const usedGB = (usedMem / 1024 / 1024 / 1024).toFixed(1);
    const totalGB = (totalMem / 1024 / 1024 / 1024).toFixed(1);
    metrics.mem = usedGB + '/' + totalGB + 'G';
  } catch (e) { log('debug', 'Memory metrics fetch failed', { error: e.message }); }
  metrics.hdd = await getDiskMetrics(log);
  return metrics;
}
