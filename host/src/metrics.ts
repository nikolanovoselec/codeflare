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
import { SYNC_STATUS_FILE } from './runtime-paths.js';
import { parseWorkspaceRepo, type WorkspaceRepo } from './git-clone.js';

const execFileAsync = promisify(execFile);

/**
 * REQ-GITHUB-015 AC1: report the GitHub repositories checked out at the top of
 * the workspace, whichever way they arrived (session clone, repository panel, or
 * the agent running git itself). The Worker persists this on the session record
 * each metrics tick, so a repository the user deletes stops being reported and
 * therefore stops being restored.
 *
 * Only direct children are inspected (a nested repository is restored by its
 * parent, not on its own), one entry per repository, ordered by repository name
 * so the reported inventory is stable. Any failure yields no entry rather than
 * an error: this feeds a best-effort restore.
 */
export async function collectWorkspaceRepos(
  workspaceRoot: string,
  log: Logger,
): Promise<WorkspaceRepo[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(workspaceRoot, { withFileTypes: true });
  } catch (e: unknown) {
    log('debug', 'Workspace repo inventory skipped', {
      error: e instanceof Error ? e.message : String(e),
    });
    return [];
  }
  const githubHost = process.env.GITHUB_HOST || 'github.com';
  const byRepo = new Map<string, WorkspaceRepo>();
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = `${workspaceRoot}/${entry.name}`;
    let origin: string;
    try {
      const { stdout } = await execFileAsync('git', ['-C', dir, 'remote', 'get-url', 'origin']);
      origin = stdout.trim();
    } catch {
      continue;
    }
    let branch: string | undefined;
    try {
      const { stdout } = await execFileAsync('git', ['-C', dir, 'symbolic-ref', '--short', 'HEAD']);
      branch = stdout.trim();
    } catch {
      branch = undefined;
    }
    const repo = parseWorkspaceRepo(origin, branch, githubHost);
    if (repo && !byRepo.has(repo.repo)) byRepo.set(repo.repo, repo);
  }
  return [...byRepo.values()].sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0));
}

/**
 * Read sync status from the file written by the rclone daemon.
 */
export function getSyncStatus(): SyncStatus {
  try {
    const data = fs.readFileSync(SYNC_STATUS_FILE, 'utf8');
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
