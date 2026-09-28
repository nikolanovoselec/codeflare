import { execFile as execFileCallback } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import localReview from './review-enforcement';
import remoteReview from './operator-review-remote';
import { findGitRoot, recallActiveRepo, resolveShellInvocationRepo, shellInvocations } from './active-repo-memory';
import { classifyReviewBoundaryCommand } from './review-helpers';

const execFile = promisify(execFileCallback);
type Mode = 'local' | 'remote' | 'unavailable';
type Handler = (event: unknown, ctx: unknown) => unknown;
type ReviewFactory = (pi: ExtensionAPI) => void;
type SelectorPi = Pick<ExtensionAPI, 'on' | 'sendMessage'>;
type Dependencies = { local: ReviewFactory; remote: ReviewFactory;
  applicability: (event: unknown, ctx: unknown) => Promise<Mode> };

/** The two Review implementations register with distinct, inactive event tables.
 * Only this selector registers Pi event handlers; the original local implementation is unmodified. */
export function registerOperatorReviewSelector(pi: SelectorPi, dependencies: Dependencies): void {
  const handlers = { local: new Map<string, Handler[]>(), remote: new Map<string, Handler[]>() };
  for (const mode of ['local', 'remote'] as const) {
    const reviewPi = { ...pi,
      sendMessage: (message: Parameters<SelectorPi['sendMessage']>[0],
        options?: Parameters<SelectorPi['sendMessage']>[1]) => {
        if (mode === 'local' && message.customType === 'pr-boundary-remote-plan') {
          pi.sendMessage({ customType: 'pr-boundary-remote-unavailable', display: true,
            content: 'Review applicability changed during local selection. No local or remote clearance; '
              + 'retry the boundary under the current Action configuration.' }, options);
          return;
        }
        pi.sendMessage(message, options);
      },
      on: (name: string, handler: Handler) => {
        const entries = handlers[mode].get(name) ?? [];
        entries.push(handler);
        handlers[mode].set(name, entries);
        return () => { handlers[mode].set(name, entries.filter(item => item !== handler)); };
      } } as unknown as ExtensionAPI;
    dependencies[mode](reviewPi);
  }
  let selected: Mode = 'unavailable';
  let unavailableReported = false;
  const dispatch = async (name: string, event: unknown, ctx: unknown) => {
    const isBoundary = (name === 'tool_call' || name === 'tool_result')
      && shellInvocations(event, (ctx as { cwd: string }).cwd).some(invocation =>
        Boolean(classifyReviewBoundaryCommand(invocation.command).kind));
    if (name === 'session_start' || isBoundary) {
      const next = await dependencies.applicability(event, ctx).catch(() => 'unavailable' as const);
      if (next !== selected && next !== 'unavailable' && name !== 'session_start') {
        for (const handler of handlers[next].get('session_start') ?? []) {
          await handler({ type: 'session_start', reason: 'reload' }, ctx);
        }
      }
      selected = next;
      if (next !== 'unavailable') unavailableReported = false;
    }
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
export async function selectOperatorReviewApplicability(event: any, ctx: any,
  runner: typeof execFile = execFile): Promise<Mode> {
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
  const repo = boundary ? resolveShellInvocationRepo(boundary)
    : findGitRoot(ctx.cwd) ?? (typeof previous === 'string' ? findGitRoot(previous) : undefined)
      ?? (recallActiveRepo() ? findGitRoot(recallActiveRepo()!) : undefined);
  if (!repo || !existsSync(join(repo, 'sdd', 'README.md'))) return 'unavailable';
  try {
    const { stdout: prText } = await runner('gh', ['pr', 'view', '--json', 'number,state,baseRefName,headRefOid'],
      { cwd: repo, encoding: 'utf8', timeout: 10_000 });
    const pr = JSON.parse(String(prText));
    if (!Number.isSafeInteger(pr.number) || pr.number < 1 || pr.state !== 'OPEN'
      || !['main', 'master', 'develop'].includes(pr.baseRefName) || !sha.test(pr.headRefOid)) return 'unavailable';
    const [{ stdout: identity }, { stdout: idText }] = await Promise.all([
      runner('gh', ['repo', 'view', '--json', 'nameWithOwner,url'], { cwd: repo, encoding: 'utf8', timeout: 10_000 }),
      runner('gh', ['api', 'repos/{owner}/{repo}', '--jq', '.id'], { cwd: repo, encoding: 'utf8', timeout: 10_000 }),
    ]);
    const target = JSON.parse(String(identity));
    const id = Number(String(idText).trim());
    if (!repoName.test(target.nameWithOwner) || !Number.isSafeInteger(id) || id < 1
      || new URL(target.url).hostname !== 'github.com') return 'unavailable';
    const encoded = Buffer.from(JSON.stringify({ repositoryId: id, pullRequest: pr.number,
      acknowledgedHead: null, targetHead: pr.headRefOid,
      payload: { range: null, rejectedFindingsStatus: 'unavailable' } }), 'utf8').toString('base64');
    const { stdout } = await runner('gh', ['api', '--include',
      '-H', 'x-codeflare-operator-boundary-select: check',
      '-H', `x-codeflare-operator-boundary-input: ${encoded}`,
      `repos/${target.nameWithOwner}/pulls/${pr.number}`], { cwd: repo, encoding: 'utf8', timeout: 20_000 });
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
  registerOperatorReviewSelector(pi, { local: localReview, remote: remoteReview,
    applicability: selectOperatorReviewApplicability });
}
