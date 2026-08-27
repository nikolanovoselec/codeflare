import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
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
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const VERSION = 1;
const MAX_MARKERS = 10;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const FUTURE_SKEW_MS = 5 * 60 * 1000;
const SHA_PATTERN = /^[0-9a-f]{40}$/;
const PROTECTED_BASES = new Set(["main", "master", "develop"]);

export type ReviewIdentity = {
  gitHost: string;
  repository: string;
  pr: number;
  branch: string;
  base: "main" | "master" | "develop";
  head: string;
};

export type CompletionMarker = ReviewIdentity & {
  version: 1;
  reviewedAt: string;
};

export type CompletionStatus = {
  status: "complete" | "missing" | "expired" | "changed";
  marker?: CompletionMarker;
};

type StoreOptions = {
  root?: string;
  now?: () => Date;
  requestSync?: () => boolean;
  isAncestor?: (base: string, head: string, repo: string) => boolean;
};

type PruneOptions = Pick<StoreOptions, "root" | "now">;

function stateRoot(root?: string): string {
  return root ?? join(homedir(), ".codeflare", "review-state", "v1");
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedIdentity(identity: ReviewIdentity): ReviewIdentity | undefined {
  const gitHost = identity.gitHost.trim().toLowerCase();
  const repository = identity.repository.trim().toLowerCase();
  if (!gitHost
    || !/^[a-z0-9.-]+$/.test(gitHost)
    || !/^[a-z0-9_.-]+\/[a-z0-9_.-]+$/.test(repository)
    || !Number.isSafeInteger(identity.pr)
    || identity.pr <= 0
    || !identity.branch
    || !PROTECTED_BASES.has(identity.base)
    || !SHA_PATTERN.test(identity.head)) return undefined;
  return { ...identity, gitHost, repository };
}

function repositoryDirectory(identity: ReviewIdentity, root?: string): string {
  return join(stateRoot(root), hash(`${identity.gitHost}\n${identity.repository}`));
}

function branchDirectory(identity: ReviewIdentity, root?: string): string {
  return join(repositoryDirectory(identity, root), hash(identity.branch));
}

export function completionPath(identity: ReviewIdentity, root?: string): string {
  const normalized = normalizedIdentity(identity);
  if (!normalized) throw new Error("Invalid review identity");
  return join(branchDirectory(normalized, root), `pr-${normalized.pr}-${normalized.base}-${normalized.head}.json`);
}

function regularFile(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

function markerFrom(path: string, now: Date, allowExpired = false): CompletionMarker | undefined {
  if (!regularFile(path)) return undefined;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const reviewedAt = typeof value.reviewedAt === "string" ? new Date(value.reviewedAt) : undefined;
    const identity = normalizedIdentity({
      gitHost: typeof value.gitHost === "string" ? value.gitHost : "",
      repository: typeof value.repository === "string" ? value.repository : "",
      pr: typeof value.pr === "number" ? value.pr : Number.NaN,
      branch: typeof value.branch === "string" ? value.branch : "",
      base: value.base as ReviewIdentity["base"],
      head: typeof value.head === "string" ? value.head : "",
    });
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

function sameIdentity(left: ReviewIdentity, right: ReviewIdentity): boolean {
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

function safeEntries(path: string): string[] {
  try {
    return readdirSync(path).sort();
  } catch {
    return [];
  }
}

function removeEmpty(path: string): void {
  try {
    if (readdirSync(path).length === 0) rmSync(path, { recursive: false });
  } catch {
    // Concurrent cleanup or a non-empty directory is harmless.
  }
}

function pruneBranch(path: string, now: Date, root: string): boolean {
  let changed = false;
  const markers: Array<{ path: string; marker: CompletionMarker }> = [];
  for (const name of safeEntries(path)) {
    const candidate = join(path, name);
    const marker = markerFrom(candidate, now);
    const expected = marker ? completionPath(marker, root) : undefined;
    if (!marker || candidate !== expected) {
      try {
        rmSync(candidate, { recursive: true, force: true });
        changed = true;
      } catch {
        // Best-effort cleanup never changes acknowledgement behavior.
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
      // A concurrent prune may already have removed it.
    }
  }
  removeEmpty(path);
  return changed;
}

export function pruneCompletionState(options: PruneOptions = {}): boolean {
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

function branchMarkers(identity: ReviewIdentity, options: StoreOptions): CompletionMarker[] {
  const normalized = normalizedIdentity(identity);
  if (!normalized) return [];
  const now = (options.now ?? (() => new Date()))();
  const directory = branchDirectory(normalized, options.root);
  pruneBranch(directory, now, stateRoot(options.root));
  return safeEntries(directory)
    .map((name) => markerFrom(join(directory, name), now))
    .filter((marker): marker is CompletionMarker => Boolean(marker));
}

export function readCompletion(identity: ReviewIdentity, options: StoreOptions = {}): CompletionStatus {
  const normalized = normalizedIdentity(identity);
  if (!normalized) return { status: "missing" };
  const now = (options.now ?? (() => new Date()))();
  const path = completionPath(normalized, options.root);
  const expired = markerFrom(path, now, true);
  if (expired && now.getTime() - Date.parse(expired.reviewedAt) > RETENTION_MS) {
    try {
      unlinkSync(path);
    } catch {
      // A concurrent reader may have removed it.
    }
    return { status: "expired" };
  }
  const markers = branchMarkers(normalized, options);
  const exact = markers.find((marker) => sameIdentity(marker, normalized));
  if (exact) return { status: "complete", marker: exact };
  return { status: markers.length > 0 ? "changed" : "missing" };
}

function defaultAncestor(base: string, head: string, repo: string): boolean {
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", base, head], {
      cwd: repo,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

export function latestAncestorCompletion(
  identity: ReviewIdentity,
  repo: string,
  options: StoreOptions = {},
): CompletionMarker | undefined {
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
  pidFile = process.env.CODEFLARE_SYNC_DAEMON_PIDFILE || "/run/codeflare/sync/sync-daemon.pid",
): boolean {
  try {
    const rawPid = readFileSync(pidFile, "utf8").trim();
    const pid = Number(rawPid);
    if (!/^[1-9][0-9]*$/.test(rawPid) || !Number.isSafeInteger(pid)) {
      console.warn("[review-completion] R2 sync trigger unavailable: invalid daemon PID");
      return false;
    }
    process.kill(pid, "SIGUSR1");
    return true;
  } catch (error) {
    console.warn(`[review-completion] R2 sync trigger unavailable: ${String(error)}`);
    return false;
  }
}

function publish(path: string, contents: string, now: Date): boolean {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  chmodSync(dirname(path), 0o700);
  const temporary = join(dirname(path), `.tmp-${process.pid}-${randomUUID()}`);
  try {
    writeFileSync(temporary, contents, { encoding: "utf8", flag: "wx", mode: 0o600 });
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        linkSync(temporary, path);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
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

export function writeCompletion(
  identity: ReviewIdentity,
  options: StoreOptions = {},
): { written: boolean; syncRequested: boolean } {
  const normalized = normalizedIdentity(identity);
  if (!normalized) throw new Error("Invalid review identity");
  const now = (options.now ?? (() => new Date()))();
  const current = readCompletion(normalized, options);
  if (current.status === "complete") return { written: false, syncRequested: false };
  const marker: CompletionMarker = {
    version: VERSION,
    ...normalized,
    reviewedAt: now.toISOString(),
  };
  const written = publish(completionPath(normalized, options.root), `${JSON.stringify(marker)}\n`, now);
  pruneBranch(branchDirectory(normalized, options.root), now, stateRoot(options.root));
  if (!written) return { written: false, syncRequested: false };
  const syncRequested = (options.requestSync ?? requestCompletionSync)();
  return { written: true, syncRequested };
}

export default function () {}
