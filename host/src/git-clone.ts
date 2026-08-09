/**
 * REQ-GITHUB-004: running-session git clone.
 *
 * The host endpoint POST /internal/git-clone clones a GitHub repo into the
 * workspace of an already-running container (the new-session path is handled by
 * entrypoint.sh at start instead). The pure repo/ref validation + target-dir
 * computation lives here so it is unit-testable without spawning git; server.ts
 * owns the fs.existsSync check, the spawn, the timeout, and the HTTP response.
 *
 * The validation guards are load-bearing: the computed values flow into a
 * `git clone` argv (never a shell string), but a repo/ref containing `..`, a
 * leading `-` (option injection), or path separators in the repo name could
 * still escape the workspace or smuggle a flag, so the shapes are pinned to the
 * same owner/name regex the Worker uses plus a ref charset that excludes spaces
 * and option-leading dashes.
 */
import path from 'node:path';

/** owner/name — same shape the Worker's clone schemas validate. */
const REPO_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
/**
 * branch/tag ref — allows nested refs (feature/x) but no spaces/shell chars,
 * and the first character may not be `-` so a ref can never be parsed by git as
 * an option (e.g. `--upload-pack=`). The charset alone is not enough: it permits
 * `-`, so the leading-character class is separated out to reject option-leading
 * dashes. Pairs with the `--branch=<ref>` + `--` end-of-options form in
 * buildCloneArgs (defense-in-depth against git argument injection).
 */
const REF_PATTERN = /^[A-Za-z0-9._/][A-Za-z0-9._/-]*$/;

export type GitCloneResolution =
  | { ok: true; repo: string; ref?: string; repoName: string; dir: string }
  | { ok: false; error: string };

/**
 * Validate the request and compute the clone target directory.
 *
 *  - Invalid repo (not owner/name) -> { ok:false }.
 *  - Present-but-invalid ref       -> { ok:false }.
 *  - Valid                         -> { ok:true, repoName, dir }.
 *
 * `repoName` is the validated part after the slash, preserved verbatim; `dir`
 * is its direct child under the normalized workspace root. The caller refuses
 * an existing `dir` before cloning.
 */
export function resolveGitClone(
  repo: unknown,
  ref: unknown,
  workspace: string,
): GitCloneResolution {
  if (typeof repo !== 'string' || !REPO_PATTERN.test(repo)) {
    return { ok: false, error: 'invalid repo' };
  }
  if (ref !== undefined && ref !== null) {
    if (typeof ref !== 'string' || !REF_PATTERN.test(ref)) {
      return { ok: false, error: 'invalid ref' };
    }
  }
  const repoName = repo.split('/')[1];
  // REPO_PATTERN permits `.` / `..` as the name segment. Resolve the workspace
  // first and require the destination to remain its direct child as an explicit
  // containment check, even though the validated basename contains no separators.
  if (repoName === '' || repoName === '.' || repoName === '..') {
    return { ok: false, error: 'invalid repo' };
  }
  const workspaceRoot = path.resolve(workspace);
  const dir = path.resolve(workspaceRoot, repoName);
  if (path.dirname(dir) !== workspaceRoot) {
    return { ok: false, error: 'invalid repo' };
  }
  const resolution: GitCloneResolution = { ok: true, repo, repoName, dir };
  if (typeof ref === 'string') resolution.ref = ref;
  return resolution;
}

/**
 * Resolve the workspace root the same way entrypoint.sh does: prefer
 * USER_WORKSPACE, else <HOME>/workspace, else /home/user/workspace.
 */
export function resolveWorkspaceRoot(env: NodeJS.ProcessEnv): string {
  return env.USER_WORKSPACE || path.join(env.HOME || '/home/user', 'workspace');
}

/**
 * Build the `git clone` argv (no shell). `--branch=<ref>` (joined form) is
 * inserted only when a ref is present, and a `--` end-of-options separator
 * precedes the positional URL + dir, so neither a ref nor the URL/dir can be
 * parsed by git as an option (guards against git argument injection such as
 * `--upload-pack=`, on top of REF_PATTERN's leading-dash rejection). The clone
 * URL uses GITHUB_HOST when set so *.ghe.com data-residency tenants resolve to
 * their own host.
 */
export function buildCloneArgs(
  repo: string,
  ref: string | undefined,
  dir: string,
  githubHost: string,
): string[] {
  const remoteRepo = repo.endsWith('.git') ? repo : `${repo}.git`;
  const url = `https://${githubHost}/${remoteRepo}`;
  return ['clone', ...(ref ? [`--branch=${ref}`] : []), '--', url, dir];
}
