/**
 * REQ-GITHUB-015: the Worker boundary for tracked session repositories.
 *
 * A container reports the repositories present in its workspace on every
 * metrics tick. That report is untrusted input: it is validated here before it
 * is persisted on the session record (AC2) and again before it is encoded into
 * the restore directive a container acts on (AC4). The shapes mirror
 * host/src/git-clone.ts so a value that survives this boundary also survives
 * the container's own re-validation.
 */

/** owner/name — same shape the clone schemas validate. */
const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
/** branch/tag ref — no spaces and never option-leading. */
const REF_PATTERN = /^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/;

/** REQ-GITHUB-015 AC2: bound on the repositories tracked for one session. */
export const MAX_TRACKED_CLONES = 20;

export interface TrackedClone {
  repo: string;
  ref?: string;
}

function validate(entry: unknown): TrackedClone | null {
  if (typeof entry !== 'object' || entry === null) return null;
  const { repo, ref } = entry as { repo?: unknown; ref?: unknown };
  if (typeof repo !== 'string' || !REPO_PATTERN.test(repo)) return null;
  const name = repo.split('/')[1];
  if (name === '.' || name === '..') return null;
  if (ref === undefined || ref === null) return { repo };
  if (typeof ref !== 'string' || !REF_PATTERN.test(ref)) return null;
  return { repo, ref };
}

/**
 * REQ-GITHUB-015 AC2: keep the well-formed entries only, one per repository
 * (first occurrence wins), ordered by repository name so the stored inventory
 * does not churn with the container's reporting order, and bounded.
 */
export function normalizeTrackedClones(input: unknown): TrackedClone[] {
  if (!Array.isArray(input)) return [];
  const byRepo = new Map<string, TrackedClone>();
  for (const entry of input) {
    const valid = validate(entry);
    if (valid && !byRepo.has(valid.repo)) byRepo.set(valid.repo, valid);
  }
  return [...byRepo.values()]
    .sort((a, b) => (a.repo < b.repo ? -1 : a.repo > b.repo ? 1 : 0))
    .slice(0, MAX_TRACKED_CLONES);
}

/**
 * REQ-GITHUB-015 AC4: encode the restore directive as `repo[#ref]` entries
 * separated by single spaces, with the repository the session was created from
 * first so the user's primary workspace is populated before the rest of the
 * time budget is spent. Both the validated repo and ref charsets exclude spaces
 * and `#`, so the encoding is unambiguous.
 */
export function buildCloneTargets(
  tracked: readonly TrackedClone[] | undefined,
  primary: TrackedClone | undefined,
): string {
  const ordered = normalizeTrackedClones([
    ...(primary ? [primary] : []),
    ...(tracked ?? []),
  ]);
  const primaryRepo = primary ? validate(primary)?.repo : undefined;
  const first = ordered.filter((c) => c.repo === primaryRepo);
  const rest = ordered.filter((c) => c.repo !== primaryRepo);
  return [...first, ...rest]
    .map((c) => (c.ref ? `${c.repo}#${c.ref}` : c.repo))
    .join(' ');
}
