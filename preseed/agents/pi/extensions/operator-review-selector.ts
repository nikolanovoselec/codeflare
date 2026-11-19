import { execFile as execFileCallback } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { createReviewEnforcement, resultText, successful, type ReviewEnforcementController } from './review-enforcement';
import { createOperatorReviewRemote, githubRepository, type OperatorReviewRemoteController } from './operator-review-remote';
import { findGitRoot, recallActiveRepo, resolveShellInvocationRepo, shellInvocations, type ShellInvocation } from './active-repo-memory';
import { cloneTargetHadGit, cloneTargetPath, rememberCloneTargetHadGit } from './graphify-helpers';
import { classifyReviewBoundaryCommand } from './review-helpers';

const execFile = promisify(execFileCallback);
type Mode = 'local' | 'remote' | 'unavailable' | 'none';
type Handler = (event: unknown, ctx: unknown) => unknown;
type ReviewFactory<T> = (pi: any) => T | void;
type SelectorPi = Pick<ExtensionAPI, 'on' | 'sendMessage'>;
type Dependencies = { local: ReviewFactory<ReviewEnforcementController>; remote: ReviewFactory<OperatorReviewRemoteController>;
  applicability: (event: unknown, ctx: any) => Promise<Mode> };

function invocationRepo(invocation: ShellInvocation, event: unknown): string | undefined {
  if (!invocation.certain) return undefined;
  if (!classifyReviewBoundaryCommand(invocation.command).clone) return resolveShellInvocationRepo(invocation);
  const target = cloneTargetPath(invocation.command, invocation.cwd, resultText(event));
  return target && existsSync(join(target, '.git')) ? findGitRoot(target) : undefined;
}

/** The two Review implementations register with distinct, inactive event tables.
 * Only this selector registers Pi event handlers; clone consent remains owned by local Review. */
export function registerOperatorReviewSelector(pi: SelectorPi, dependencies: Dependencies): void {
  const handlers = { local: new Map<string, Handler[]>(), remote: new Map<string, Handler[]>() };
  const reviewPi = (mode: 'local' | 'remote') => ({ ...pi,
      on: (name: string, handler: Handler) => {
        const entries = handlers[mode].get(name) ?? [];
        entries.push(handler);
        handlers[mode].set(name, entries);
        return () => { handlers[mode].set(name, entries.filter(item => item !== handler)); };
      } } as unknown as ExtensionAPI);
  const local = dependencies.local(reviewPi('local'));
  const remote = dependencies.remote(reviewPi('remote'));
  let selected: Mode = 'unavailable';
  let selectedRepo: string | undefined;
  let unavailableReported = false;
  let selectionEpoch = 0;
  const dispatch = async (name: string, event: unknown, ctx: unknown) => {
    // Attempted commands are not completed Git transitions. Preserve pre-tool guards.
    if (name === 'tool_result' && !successful(event)) return;
    if (name === 'session_shutdown') selectionEpoch += 1;
    const clones = shellInvocations(event, (ctx as { cwd: string }).cwd)
      .filter(invocation => classifyReviewBoundaryCommand(invocation.command).clone);
    if (clones.length && (name === 'tool_call' || name === 'tool_execution_start')) {
      ++selectionEpoch;
      // Record the existing consent guard without selecting or starting Review
      // against a checkout that does not exist yet.
      const id = (event as any)?.toolCallId ?? (event as any)?.toolUseId ?? (event as any)?.id;
      if (typeof id === 'string') for (const invocation of clones) {
        const target = cloneTargetPath(invocation.command, invocation.cwd);
        if (target && cloneTargetHadGit(id, target) === undefined)
          rememberCloneTargetHadGit(id, target, existsSync(join(target, '.git')));
      }
      return;
    }
    if (clones.length && name === 'tool_result'
      && ((event as any)?.isError === true || (event as any)?.result?.isError === true)) return;
    const isBoundary = (name === 'tool_call' || name === 'tool_result')
      && shellInvocations(event, (ctx as { cwd: string }).cwd).some(invocation =>
        Boolean(classifyReviewBoundaryCommand(invocation.command).kind));
    if (name === 'session_start' || isBoundary) {
      const revision = ++selectionEpoch;
      const next = await dependencies.applicability(event, ctx).catch(() => 'unavailable' as const);
      if (revision !== selectionEpoch) return;
      const invocation = isBoundary ? shellInvocations(event, (ctx as { cwd: string }).cwd)
        .filter(item => Boolean(classifyReviewBoundaryCommand(item.command).kind)).at(-1) : undefined;
      const repo = invocation ? invocationRepo(invocation, event)
        : name === 'session_start' ? findGitRoot((ctx as { cwd: string }).cwd)
          ?? (recallActiveRepo() ? findGitRoot(recallActiveRepo()!) : undefined)
          ?? (ctx as any).sessionManager?.getBranch?.().filter((entry: any) => entry?.type === 'custom'
            && (entry.customType === 'operator-review-remote-round'
              || entry.customType === 'operator-review-remote-pending')).at(-1)?.data?.repo : undefined;
      const remoteChanged = selected === 'remote' && (next !== 'remote'
        || Boolean(repo && selectedRepo && repo !== selectedRepo));
      if (remoteChanged) {
        for (const handler of handlers.remote.get('session_shutdown') ?? []) {
          await handler({ type: 'session_shutdown', reason: 'reload' }, ctx);
          if (revision !== selectionEpoch) return;
        }
      }
      const startRemote = next === 'remote' && (selected !== 'remote' || remoteChanged)
        && name !== 'session_start' && clones.length === 0;
      selected = next;
      if (repo) selectedRepo = repo;
      if (startRemote) {
        for (const handler of handlers.remote.get('session_start') ?? []) {
          await handler({ type: 'session_start', reason: 'reload' }, ctx);
          if (revision !== selectionEpoch) return;
        }
      }
      else if (next !== 'remote') selectedRepo = undefined;
      if (next !== 'unavailable') unavailableReported = false;
    }
    // Confirmed absence is inert, not local fallback or Review completion.
    if (selected === 'none') return;
    if (selected === 'unavailable') {
      if (!unavailableReported && ((isBoundary && name === 'tool_result')
        || name === 'session_start' && Boolean(findGitRoot((ctx as { cwd: string }).cwd)))) {
        unavailableReported = true;
        pi.sendMessage({ customType: 'pr-boundary-remote-unavailable',
          content: 'Review applicability is unavailable. Neither local nor remote Review can clear this boundary.',
          display: true });
      }
      return;
    }
    if (selected === 'remote' && name === 'tool_result' && clones.length) {
      const revision = selectionEpoch;
      const repo = selectedRepo;
      const context = ctx as any;
      const file = context.sessionManager?.getSessionFile?.();
      const isCurrent = () => revision === selectionEpoch && selected === 'remote'
        && selectedRepo === repo && context.sessionManager?.getSessionFile?.() === file;
      if (!local || !remote || !repo) {
        pi.sendMessage({ customType: 'pr-boundary-remote-unavailable', display: true,
          content: 'Protected clone Review is unavailable. No local fallback or clearance.' });
        return;
      }
      await local.consentClone(event, context, async (review, consentContext) => {
        if (isCurrent() && review.repo === repo) await remote.launchConsented(review, consentContext, isCurrent);
      }, isCurrent);
      return;
    }
    for (const handler of handlers[selected].get(name) ?? []) await handler(event, ctx);
  };
  for (const name of new Set(['session_start', 'tool_call', 'tool_result', 'agent_end', 'agent_settled',
    ...handlers.local.keys(), ...handlers.remote.keys()])) {
    (pi.on as (event: string, handler: (event: unknown, ctx: unknown) => Promise<void>) => () => void)(
      name, (event, ctx) => dispatch(name, event, ctx));
  }
}

const repoName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const sha = /^[a-f0-9]{40}$/i;
type Enrollment = 'local' | 'remote-candidate' | 'unavailable';

/** Parent-bound enrollment read; no GitHub credential or remote execution authority. */
export async function readReviewEnrollment(repository: string, send: typeof fetch = fetch): Promise<Enrollment> {
  try {
    const response = await send('https://operator.internal/v1/review/applicability', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ repository }), redirect: 'error', signal: AbortSignal.timeout(10_000),
    });
    if (response.status !== 200 || !response.body) return 'unavailable';
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 4096) return 'unavailable';
        chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Buffer.concat(chunks)));
    return value && Object.keys(value).length === 1
      && ['local', 'remote-candidate', 'unavailable'].includes(value.selection) ? value.selection : 'unavailable';
  } catch { return 'unavailable'; }
}

/** Resolve public-GitHub CLI selection from local inputs, never remote metadata. */
async function localReviewRepository(repo: string, runner: typeof execFile): Promise<string | undefined> {
  const parse = (value: string) => {
    const name = value.replace(/^github\.com\//i, '');
    const repository = repoName.test(name) ? name.toLowerCase() : githubRepository(value);
    return repository && !repository.split('/').some(part => part === '.' || part === '..') ? repository : undefined;
  };
  const override = process.env.GH_REPO?.trim();
  const host = process.env.GH_HOST?.trim().toLowerCase();
  if (override) {
    if (host && host !== 'github.com' && repoName.test(override)) return undefined;
    return parse(override);
  }
  if (host && host !== 'github.com') return undefined;
  const { stdout } = await runner('git', ['remote', '-v'], { cwd: repo, encoding: 'utf8' });
  const remotes = new Map<string, { url: string; fetch: boolean }>();
  for (const line of String(stdout).trim().split('\n')) {
    const match = /^(\S+)\s+(\S+)\s+\((fetch|push)\)$/.exec(line);
    if (!match) return undefined;
    const prior = remotes.get(match[1]!);
    if (!prior || match[3] === 'fetch') remotes.set(match[1]!, { url: match[2]!, fetch: match[3] === 'fetch' });
  }
  if (!remotes.size) return undefined;
  let resolved = '';
  try {
    const config = await runner('git', ['config', '--get-regexp', '^remote\\..*\\.gh-resolved$'], { cwd: repo, encoding: 'utf8' });
    resolved = String(config.stdout).trim();
  } catch (error) {
    if ((error as { code?: unknown }).code !== 1) throw error;
  }
  const configured = new Set<string>();
  for (const line of resolved ? resolved.split('\n') : []) {
    const match = /^remote\.(.+)\.gh-resolved\s+(.+)$/.exec(line);
    if (!match) return undefined;
    const remote = remotes.get(match[1]!);
    if (!remote) continue;
    if (!githubRepository(remote.url)) return undefined;
    const repository = match[2] === 'base' ? githubRepository(remote.url) : parse(match[2]!.trim());
    if (!repository) return undefined;
    configured.add(repository);
  }
  if (configured.size) return configured.size === 1 ? [...configured][0] : undefined;
  const priority = (name: string) => {
    const rank = ['upstream', 'github', 'origin'].indexOf(name.toLowerCase());
    return rank < 0 ? 3 : rank;
  };
  const rank = Math.min(...[...remotes.keys()].map(priority));
  const candidates = [...remotes].filter(([name]) => priority(name) === rank)
    .map(([, remote]) => githubRepository(remote.url));
  return candidates.every(Boolean) && new Set(candidates).size === 1 ? candidates[0] : undefined;
}

export async function selectOperatorReviewApplicability(event: any, ctx: any,
  runner: typeof execFile = execFile,
  enrollment: (repository: string) => Promise<Enrollment> = readReviewEnrollment): Promise<Mode> {
  if (process.env.ENTERPRISE_MODE !== 'active') return 'local';
  const invocations = shellInvocations(event, ctx.cwd);
  const boundary = invocations.filter(invocation =>
    Boolean(classifyReviewBoundaryCommand(invocation.command).kind)).at(-1);
  // Unrelated shell output cannot choose a Review path. Keep the previously
  // selected path by querying the current checkout only at actual boundaries.
  const previous = !boundary && typeof ctx.sessionManager?.getBranch === 'function'
    ? ctx.sessionManager.getBranch().filter((entry: any) => entry?.type === 'custom'
      && (entry.customType === 'operator-review-remote-round'
        || entry.customType === 'operator-review-remote-pending')).at(-1)?.data?.repo : undefined;
  const repo = boundary ? invocationRepo(boundary, event)
    : findGitRoot(ctx.cwd) ?? (typeof previous === 'string' ? findGitRoot(previous) : undefined)
      ?? (recallActiveRepo() ? findGitRoot(recallActiveRepo()!) : undefined);
  if (!repo) return boundary && classifyReviewBoundaryCommand(boundary.command).clone ? 'unavailable' : 'none';
  if (!existsSync(join(repo, 'sdd', 'README.md'))) return 'none';
  try {
    const repository = await localReviewRepository(repo, runner);
    if (!repository) return 'unavailable';
    const disposition = await enrollment(repository);
    if (disposition !== 'remote-candidate') return disposition;
    let prText: unknown;
    try {
      const response = await runner('gh', ['pr', 'view', '--json', 'number,state,baseRefName,headRefOid,url'],
        { cwd: repo, encoding: 'utf8', timeout: 10_000 });
      prText = response.stdout;
    } catch (error) {
      const stderr = String((error as { stderr?: unknown })?.stderr ?? '');
      if (/no pull requests found|could not resolve to a pullrequest/i.test(stderr)) return 'none';
      throw error;
    }
    const pr = JSON.parse(String(prText));
    if (!Number.isSafeInteger(pr.number) || pr.number < 1 || !['OPEN', 'CLOSED', 'MERGED'].includes(pr.state)
      || typeof pr.baseRefName !== 'string' || !pr.baseRefName.trim() || !sha.test(pr.headRefOid)) return 'unavailable';
    if (pr.state !== 'OPEN' || !['main', 'master', 'develop'].includes(pr.baseRefName)) return 'none';
    const target = new URL(pr.url);
    if (target.origin !== 'https://github.com' || target.username || target.password || target.search || target.hash
      || target.pathname.toLowerCase() !== `/${repository}/pull/${pr.number}`) return 'unavailable';
    const { stdout: idText } = await runner('gh', ['api', '--hostname', 'github.com', `repos/${repository}`, '--jq', '.id'],
      { cwd: repo, encoding: 'utf8', timeout: 10_000 });
    const id = Number(String(idText).trim());
    if (!Number.isSafeInteger(id) || id < 1) return 'unavailable';
    const encoded = Buffer.from(JSON.stringify({ repositoryId: id, pullRequest: pr.number,
      acknowledgedHead: null, targetHead: pr.headRefOid,
      payload: { range: null, rejectedFindingsStatus: 'unavailable' } }), 'utf8').toString('base64');
    const { stdout } = await runner('gh', ['api', '--hostname', 'github.com', '--include',
      '-H', 'x-codeflare-operator-boundary-select: check',
      '-H', `x-codeflare-operator-boundary-input: ${encoded}`,
      `repos/${repository}/pulls/${pr.number}`], { cwd: repo, encoding: 'utf8', timeout: 20_000 });
    const output = String(stdout).replace(/\r\n/g, '\n');
    if (output.length > 256 * 1024) return 'unavailable';
    const split = output.indexOf('\n\n');
    if (split < 0 || !/^HTTP\/(?:1\.1|2(?:\.0)?|3) 200(?:\s|$)/.test(output)) return 'unavailable';
    const headers = output.slice(0, split).split('\n').filter(line => /^x-codeflare-operator-boundary-selection:/i.test(line));
    if (headers.length !== 1) return 'unavailable';
    const mode = headers[0]!.split(':').slice(1).join(':').trim();
    if (mode !== 'remote' && mode !== 'local') return 'unavailable';
    const response = JSON.parse(output.slice(split + 2));
    return response.number === pr.number && response.head?.sha === pr.headRefOid ? mode : 'unavailable';
  } catch { return 'unavailable'; }
}

export default function operatorReviewSelector(pi: ExtensionAPI): void {
  registerOperatorReviewSelector(pi, { local: createReviewEnforcement, remote: createOperatorReviewRemote,
    applicability: selectOperatorReviewApplicability });
}
