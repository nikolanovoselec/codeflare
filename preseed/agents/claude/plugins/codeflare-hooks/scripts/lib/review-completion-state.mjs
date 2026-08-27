#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  chmodSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const VERSION = 1;
const MAX_MARKERS = 10;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const PROTECTED_BASES = new Set(['main', 'master', 'develop']);

function stateRoot(root) {
  return root ?? join(homedir(), '.codeflare', 'review-state', 'v1');
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function normalizedIdentity(identity) {
  const gitHost = typeof identity?.gitHost === 'string' ? identity.gitHost.trim().toLowerCase() : '';
  const repository = typeof identity?.repository === 'string' ? identity.repository.trim().toLowerCase() : '';
  if (!gitHost
    || !/^[a-z0-9.-]+$/.test(gitHost)
    || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository)
    || !Number.isSafeInteger(identity?.pr)
    || identity.pr <= 0
    || typeof identity.branch !== 'string'
    || !identity.branch
    || !PROTECTED_BASES.has(identity.base)
    || typeof identity.head !== 'string'
    || !SHA_PATTERN.test(identity.head)) return undefined;
  return { ...identity, gitHost, repository };
}

function repositoryDirectory(identity, root) {
  return join(stateRoot(root), hash(`${identity.gitHost}\n${identity.repository}`));
}

function branchDirectory(identity, root) {
  return join(repositoryDirectory(identity, root), hash(identity.branch));
}

export function completionPath(identity, root) {
  const normalized = normalizedIdentity(identity);
  if (!normalized) throw new Error('Invalid review identity');
  return join(branchDirectory(normalized, root), `pr-${normalized.pr}-${normalized.base}-${normalized.head}.json`);
}

function regularFile(path) {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function markerFrom(path, now, allowExpired = false) {
  if (!regularFile(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    const reviewedAt = typeof value.reviewedAt === 'string' ? new Date(value.reviewedAt) : undefined;
    const identity = normalizedIdentity(value);
    if (value.version !== VERSION
      || !identity
      || !reviewedAt
      || Number.isNaN(reviewedAt.getTime())
      || reviewedAt.getTime() > now.getTime() + FUTURE_SKEW_MS
      || (!allowExpired && now.getTime() - reviewedAt.getTime() > RETENTION_MS)) return undefined;
    return { version: VERSION, ...identity, reviewedAt: reviewedAt.toISOString() };
  } catch {
    return undefined;
  }
}

function sameIdentity(left, right) {
  const a = normalizedIdentity(left);
  const b = normalizedIdentity(right);
  return Boolean(a && b
    && a.gitHost === b.gitHost
    && a.repository === b.repository
    && a.pr === b.pr
    && a.branch === b.branch
    && a.base === b.base
    && a.head === b.head);
}

function safeEntries(path) {
  try {
    return readdirSync(path).sort();
  } catch {
    return [];
  }
}

function removeEmpty(path) {
  try {
    if (readdirSync(path).length === 0) rmSync(path, { recursive: false });
  } catch {
    // Concurrent cleanup or a non-empty directory is harmless.
  }
}

function pruneBranch(path, now, root) {
  let changed = false;
  const markers = [];
  for (const name of safeEntries(path)) {
    const candidate = join(path, name);
    const marker = markerFrom(candidate, now);
    const expected = marker ? completionPath(marker, root) : undefined;
    if (!marker || candidate !== expected) {
      try {
        rmSync(candidate, { recursive: true, force: true });
        changed = true;
      } catch {
        // Best effort.
      }
      continue;
    }
    markers.push({ path: candidate, marker });
  }
  markers.sort((left, right) => {
    const byTime = Date.parse(right.marker.reviewedAt) - Date.parse(left.marker.reviewedAt);
    return byTime || left.marker.head.localeCompare(right.marker.head);
  });
  for (const stale of markers.slice(MAX_MARKERS)) {
    try {
      unlinkSync(stale.path);
      changed = true;
    } catch {
      // Concurrent cleanup may already have removed it.
    }
  }
  removeEmpty(path);
  return changed;
}

export function pruneCompletionState(options = {}) {
  const root = stateRoot(options.root);
  const now = (options.now ?? (() => new Date()))();
  let changed = false;
  for (const repositoryName of safeEntries(root)) {
    const repositoryPath = join(root, repositoryName);
    let repositoryStat;
    try {
      repositoryStat = lstatSync(repositoryPath);
    } catch {
      continue;
    }
    if (!repositoryStat.isDirectory()) {
      rmSync(repositoryPath, { recursive: true, force: true });
      changed = true;
      continue;
    }
    for (const branchName of safeEntries(repositoryPath)) {
      const branchPath = join(repositoryPath, branchName);
      let branchStat;
      try {
        branchStat = lstatSync(branchPath);
      } catch {
        continue;
      }
      if (!branchStat.isDirectory()) {
        rmSync(branchPath, { recursive: true, force: true });
        changed = true;
        continue;
      }
      if (pruneBranch(branchPath, now, root)) changed = true;
    }
    removeEmpty(repositoryPath);
  }
  removeEmpty(root);
  return changed;
}

function branchMarkers(identity, options) {
  const normalized = normalizedIdentity(identity);
  if (!normalized) return [];
  const now = (options.now ?? (() => new Date()))();
  const directory = branchDirectory(normalized, options.root);
  pruneBranch(directory, now, stateRoot(options.root));
  return safeEntries(directory)
    .map((name) => markerFrom(join(directory, name), now))
    .filter(Boolean);
}

export function readCompletion(identity, options = {}) {
  const normalized = normalizedIdentity(identity);
  if (!normalized) return { status: 'missing' };
  const now = (options.now ?? (() => new Date()))();
  const path = completionPath(normalized, options.root);
  const expired = markerFrom(path, now, true);
  if (expired && now.getTime() - Date.parse(expired.reviewedAt) > RETENTION_MS) {
    try {
      unlinkSync(path);
    } catch {
      // Concurrent cleanup may already have removed it.
    }
    return { status: 'expired' };
  }
  const markers = branchMarkers(normalized, options);
  const exact = markers.find((marker) => sameIdentity(marker, normalized));
  if (exact) return { status: 'complete', marker: exact };
  return { status: markers.length > 0 ? 'changed' : 'missing' };
}

function defaultAncestor(base, head, repo) {
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', base, head], {
      cwd: repo,
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

export function latestAncestorCompletion(identity, repo, options = {}) {
  const normalized = normalizedIdentity(identity);
  if (!normalized) return undefined;
  const isAncestor = options.isAncestor ?? defaultAncestor;
  return branchMarkers(normalized, options)
    .filter((marker) => marker.gitHost === normalized.gitHost
      && marker.repository === normalized.repository
      && marker.pr === normalized.pr
      && marker.branch === normalized.branch
      && marker.base === normalized.base
      && marker.head !== normalized.head)
    .sort((left, right) => Date.parse(right.reviewedAt) - Date.parse(left.reviewedAt))
    .find((marker) => isAncestor(marker.head, normalized.head, repo));
}

export function requestCompletionSync(
  pidFile = process.env.CODEFLARE_SYNC_DAEMON_PIDFILE || '/run/codeflare/sync/sync-daemon.pid',
) {
  try {
    const rawPid = readFileSync(pidFile, 'utf8').trim();
    const pid = Number(rawPid);
    if (!/^[1-9][0-9]*$/.test(rawPid) || !Number.isSafeInteger(pid)) {
      console.warn('[review-completion] R2 sync trigger unavailable: invalid daemon PID');
      return false;
    }
    process.kill(pid, 'SIGUSR1');
    return true;
  } catch (error) {
    console.warn(`[review-completion] R2 sync trigger unavailable: ${String(error)}`);
    return false;
  }
}

function publish(path, contents, now) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temporary = join(dirname(path), `.tmp-${process.pid}-${randomUUID()}`);
  try {
    writeFileSync(temporary, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        linkSync(temporary, path);
        return true;
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        const existing = markerFrom(path, now, true);
        if (existing) return false;
        rmSync(path, { recursive: true, force: true });
      }
    }
    return false;
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function writeCompletion(identity, options = {}) {
  const normalized = normalizedIdentity(identity);
  if (!normalized) throw new Error('Invalid review identity');
  const now = (options.now ?? (() => new Date()))();
  if (readCompletion(normalized, options).status === 'complete') {
    return { written: false, syncRequested: false };
  }
  const marker = { version: VERSION, ...normalized, reviewedAt: now.toISOString() };
  const written = publish(completionPath(normalized, options.root), `${JSON.stringify(marker)}\n`, now);
  pruneBranch(branchDirectory(normalized, options.root), now, stateRoot(options.root));
  if (!written) return { written: false, syncRequested: false };
  const syncRequested = (options.requestSync ?? requestCompletionSync)();
  return { written: true, syncRequested };
}

function commandOutput(command, args, cwd) {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 10_000,
  }).trim();
}

export function resolveReviewCandidate(cwd) {
  try {
    const repo = commandOutput('git', ['rev-parse', '--show-toplevel'], cwd);
    const branch = commandOutput('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], repo);
    const localHead = commandOutput('git', ['rev-parse', 'HEAD'], repo);
    const repository = JSON.parse(commandOutput('gh', ['repo', 'view', '--json', 'nameWithOwner,url'], repo));
    const pr = JSON.parse(commandOutput('gh', [
      'pr', 'view', branch,
      '--json', 'state,isDraft,baseRefName,headRefName,headRefOid,number,url',
    ], repo));
    const gitHost = new URL(repository.url).hostname.toLowerCase();
    const identity = normalizedIdentity({
      gitHost,
      repository: String(repository.nameWithOwner ?? '').toLowerCase(),
      pr: pr.number,
      branch: pr.headRefName,
      base: pr.baseRefName,
      head: pr.headRefOid,
    });
    return pr.state === 'OPEN' && identity && identity.branch === branch
      ? { repo, identity, localHead, eligible: identity.head === localHead }
      : undefined;
  } catch {
    return undefined;
  }
}

export function resolveReviewIdentity(cwd) {
  const candidate = resolveReviewCandidate(cwd);
  return candidate?.eligible ? { repo: candidate.repo, identity: candidate.identity } : undefined;
}

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const command = process.argv[2];
  if (command === 'prune') {
    const changed = pruneCompletionState();
    if (changed) requestCompletionSync();
    process.stdout.write(`${JSON.stringify({ changed })}\n`);
  } else if (command === 'status' || command === 'mark') {
    const cwd = argumentValue('--cwd');
    const candidate = cwd ? resolveReviewCandidate(cwd) : undefined;
    if (!candidate || (command === 'mark' && !candidate.eligible)) {
      process.stdout.write(`${JSON.stringify({ eligible: false })}\n`);
    } else if (!candidate.eligible) {
      process.stdout.write(`${JSON.stringify({
        eligible: false,
        retryable: true,
        repo: candidate.repo,
        identity: candidate.identity,
        localHead: candidate.localHead,
      })}\n`);
    } else if (command === 'mark') {
      const result = writeCompletion(candidate.identity);
      process.stdout.write(`${JSON.stringify({ eligible: true, identity: candidate.identity, ...result })}\n`);
    } else {
      const completion = readCompletion(candidate.identity);
      const ancestor = completion.status === 'complete'
        ? undefined
        : latestAncestorCompletion(candidate.identity, candidate.repo);
      process.stdout.write(`${JSON.stringify({
        eligible: true,
        repo: candidate.repo,
        identity: candidate.identity,
        completion,
        ancestor,
      })}\n`);
    }
  } else {
    process.stderr.write('Usage: review-completion-state.mjs prune|status --cwd <repo>|mark --cwd <repo>\n');
    process.exitCode = 2;
  }
}
