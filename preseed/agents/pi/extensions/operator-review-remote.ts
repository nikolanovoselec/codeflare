import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { findGitRoot, recallActiveRepo, shellInvocations, resolveShellInvocationRepo } from './active-repo-memory';
import { classifyReviewBoundaryCommand, exposureTargetsCheckedOutBranch, REVIEW_TRIAGE_HEADER, REVIEW_TRIAGE_DIVIDER } from './review-helpers';
import { executableShellCommands, shellCommandArguments, shellCommandExecutable } from './guard-helpers';

const execFile = promisify(execFileCallback);
type RejectedFinding = { findingId: string; priorActivityId: string; priorRound: number;
  priorHead: string; originalReportDigest: string; rationale: string; evidence: string };
type Boundary = { repository: string; repositoryId: number; pullRequest: number; head: string; repo: string;
  rejectedFindings?: RejectedFinding[] };
type Selection = { mode: 'remote' | 'unavailable'; activityId?: string };
type Dependencies = { currentBoundary: (event: unknown, ctx: unknown) => Promise<Boundary | undefined>;
  selectBoundary: (boundary: Boundary, readOnly?: boolean) => Promise<Selection>;
  readPublishedResult: (boundary: Boundary, activityId: string) => Promise<unknown> };
type ReviewPi = Pick<ExtensionAPI, 'on' | 'sendMessage' | 'appendEntry'>;
const sha = /^[a-f0-9]{40}$/i;
const id = /^[A-Za-z0-9_-]{1,128}$/;

function isBoundary(event: any, ctx: any): boolean {
  const invocations = shellInvocations(event, ctx.cwd);
  return invocations.some(invocation => {
    const classified = classifyReviewBoundaryCommand(invocation.command);
    return classified.event === 'push' || classified.event === 'pr-create';
  });
}
type Pending = Boundary & { sessionFile?: string; startedAt: number };
type Round = Pending & { activityId: string };
const ROUND_ENTRY = 'operator-review-remote-round';
const PENDING_ENTRY = 'operator-review-remote-pending';
const REJECTIONS_ENTRY = 'operator-review-remote-rejections';
function eligibleRejections(ctx: any, boundary: Boundary): RejectedFinding[] | undefined {
  const sessionFile = ctx.sessionManager.getSessionFile?.();
  const saved = ctx.sessionManager.getBranch().filter((entry: any) => entry.type === 'custom'
    && entry.customType === REJECTIONS_ENTRY).at(-1)?.data;
  if (!saved || !sessionFile || saved.sessionFile !== sessionFile
    || saved.repository !== boundary.repository || saved.repositoryId !== boundary.repositoryId
    || saved.pullRequest !== boundary.pullRequest || saved.repo !== boundary.repo
    || saved.head === boundary.head || !sha.test(saved.head)
    || !Array.isArray(saved.rejectedFindings) || saved.rejectedFindings.length > 20) return;
  return saved.rejectedFindings;
}
function pendingMarker(ctx: any): Pending | undefined {
  const marker = ctx.sessionManager.getBranch().filter((entry: any) => entry.type === 'custom'
    && entry.customType === PENDING_ENTRY).at(-1)?.data;
  return marker && typeof marker === 'object' ? marker as Pending : undefined;
}
function branchMarker(ctx: any): Round | undefined {
  const marker = ctx.sessionManager.getBranch().filter((entry: any) => entry.type === 'custom'
    && entry.customType === ROUND_ENTRY).at(-1)?.data;
  return marker && typeof marker === 'object' ? marker as Round : undefined;
}
function samePending(a: Pending | undefined, b: Pending): boolean {
  return a?.repository === b.repository && a?.repositoryId === b.repositoryId
    && a?.pullRequest === b.pullRequest && a?.head === b.head
    && a?.sessionFile === b.sessionFile && a?.startedAt === b.startedAt;
}
function sameRound(a: Round | undefined, b: Round): boolean {
  return samePending(a, b) && a?.activityId === b.activityId;
}
function branchHasPlan(ctx: any, round: Round): boolean {
  return sameRound(branchMarker(ctx), round)
    && (!round.sessionFile || ctx.sessionManager.getSessionFile?.() === round.sessionFile);
}
function ciTerminal(ctx: any, boundary: Round): 'success' | 'failure' | 'timeout' | undefined {
  const entries = ctx.sessionManager.getBranch();
  const markerIndex = entries.map((entry: any) => entry.type === 'custom'
    && entry.customType === ROUND_ENTRY).lastIndexOf(true);
  if (markerIndex < 0 || !branchHasPlan(ctx, boundary)) return;
  const after = entries.slice(markerIndex + 1);
  const calls = after.flatMap((entry: any) => entry.type === 'message'
    && entry.message?.role === 'assistant' && Array.isArray(entry.message.content)
    ? entry.message.content.filter((part: any) => part.type === 'toolCall' && part.name === 'subagent') : []);
  return calls.map((call: any) => {
    const args = call.arguments;
    if (!args || args.subagent_type !== 'ci-monitor' || args.run_in_background !== true
      || args.inherit_context !== false || typeof args.prompt !== 'string') return undefined;
    try {
      const request = JSON.parse(args.prompt);
      if (request.repo !== boundary.repository || request.pr !== boundary.pullRequest
        || request.head !== boundary.head || request.cwd !== boundary.repo) return undefined;
    } catch { return undefined; }
    if (!after.some((entry: any) => entry.type === 'message' && entry.message?.role === 'toolResult'
      && entry.message.toolCallId === call.id && entry.message.toolName === 'subagent'
      && entry.message.isError !== true)) return undefined;
    return after.map((entry: any) => {
      if (entry.type !== 'custom_message' || entry.customType !== 'subagent-notification'
        || typeof entry.content !== 'string') return undefined;
      const text = entry.content;
      const toolId = /<tool-use-id>([^<]+)<\/tool-use-id>/.exec(text)?.[1];
      const status = /<status>([^<]+)<\/status>/.exec(text)?.[1];
      const result = /(?:^|>)CI_RESULT\s+(success|failure|timeout)\b/mi.exec(text)?.[1];
      const identity = /^pr=(\d+)\s+head=([a-f0-9]{40})\s+repo=([^\s<]+)/mi.exec(text);
      return toolId === call.id && /^(?:Done|Completed)$/i.test(status ?? '')
        && Number(identity?.[1]) === boundary.pullRequest && identity?.[2] === boundary.head
        && identity?.[3] === boundary.repository ? result as 'success' | 'failure' | 'timeout' : undefined;
    }).find(Boolean);
  }).find(Boolean);
}

/** Protected publication consumption belongs exclusively to the remote Review path. */
export function registerOperatorReviewRemote(pi: ReviewPi, dependencies: Dependencies): void {
  let round: Round | undefined;
  let pending: Pending | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let checking = false;
  let epoch = 0;
  let submissionEpoch = 0;
  const stop = () => { epoch += 1; if (timer) clearTimeout(timer); timer = undefined; round = undefined; pending = undefined; };
  const alreadyDelivered = (ctx: any, active: Round) => ctx.sessionManager.getBranch().some((entry: any) =>
    entry.type === 'custom_message' && entry.customType === 'pr-boundary-original-findings'
    && entry.details?.repository === active.repository && entry.details?.pr === active.pullRequest
    && entry.details?.head === active.head && entry.details?.activityId === active.activityId);
  const inspect = async (ctx: any): Promise<void> => {
    const active = round;
    const observedEpoch = epoch;
    if (!active || checking || !branchHasPlan(ctx, active) || !ciTerminal(ctx, active)
      || alreadyDelivered(ctx, active)) return;
    checking = true;
    try {
      const published = await dependencies.readPublishedResult(active, active.activityId)
        .catch(() => ({ status: 'unavailable' }));
      // Both network waits and Pi session switches can supersede this round.
      if (epoch !== observedEpoch || !sameRound(round, active) || !branchHasPlan(ctx, active) || !ciTerminal(ctx, active)
        || alreadyDelivered(ctx, active)) return;
      const current = await dependencies.currentBoundary({ type: 'session_start' }, ctx);
      if (epoch !== observedEpoch || !sameRound(round, active)) return;
      if (!current || current.repository !== active.repository || current.repositoryId !== active.repositoryId
        || current.pullRequest !== active.pullRequest || current.head !== active.head
        || !branchHasPlan(ctx, active)) {
        stop(); return;
      }
      if (!published || typeof published !== 'object') return;
      const result = published as Record<string, any>;
      if (result.status !== 'published' || result.repositoryId !== active.repositoryId
        || result.pullRequest !== active.pullRequest || result.activityId !== active.activityId
        || result.head !== active.head || !Number.isSafeInteger(result.round)
        || !/^[a-f0-9]{64}$/i.test(result.artifactDigest)
        || !Array.isArray(result.findings) || result.findings.length > 20) return;
      const findings = result.findings.filter((finding: any) => typeof finding.id === 'string'
        && typeof finding.message === 'string' && typeof finding.evidence === 'string');
      if (findings.length !== result.findings.length) return;
      pi.sendMessage({ customType: 'pr-boundary-original-findings', display: true,
        details: { repository: active.repository, pr: active.pullRequest, head: active.head,
          activityId: active.activityId, round: result.round, artifactDigest: result.artifactDigest,
          omittedFindings: result.omittedFindings ?? 0, findings },
        content: `Authenticated protected Review publication for ${active.repository}#${active.pullRequest} `
          + `and exact-head CI are terminal. Original findings (advisory, not clearance):\n`
          + findings.map((finding: any) => `- ${finding.id}: ${finding.message} — ${finding.evidence}`).join('\n')
          + (result.omittedFindings ? `\n${result.omittedFindings} additional finding(s) omitted by the bounded projection; no clearance.` : '')
          + '\nTriage these together with CI, present accepted/rejected findings with reasons, '
          + 'then enter a separate FIX phase for accepted work. Rejected findings remain unresolved '
          + 'until independently reassessed in the next Review round.' }, { triggerTurn: true });
      if (timer) { clearTimeout(timer); timer = undefined; }
    } finally { checking = false; }
  };
  const activate = (boundary: Boundary, activityId: string, ctx: any, asynchronous = false): void => {
    const saved = branchMarker(ctx);
    const next: Round = saved && saved.repository === boundary.repository
      && saved.pullRequest === boundary.pullRequest && saved.head === boundary.head
      && saved.activityId === activityId && branchHasPlan(ctx, saved)
      ? saved : { ...boundary, activityId,
        sessionFile: ctx.sessionManager.getSessionFile?.(), startedAt: Date.now() };
    if (sameRound(round, next)) return;
    epoch += 1;
    if (timer) { clearTimeout(timer); timer = undefined; }
    pending = undefined;
    round = next;
    if (!sameRound(saved, next)) {
      pi.appendEntry(ROUND_ENTRY, next);
      pi.sendMessage({ customType: 'pr-boundary-remote-plan', display: true,
        details: { repository: next.repository, pr: next.pullRequest, head: next.head, activityId: next.activityId },
        content: `Protected Operator Review owns ${next.repository}#${next.pullRequest} at ${next.head}. `
          + 'Do not start local reviewers, publish a check or mark this Review complete. '
          + `Launch only the attached ci-monitor for ${JSON.stringify({ repo: next.repository,
            pr: next.pullRequest, head: next.head, cwd: next.repo })} `
          + 'with run_in_background=true and inherit_context=false. '
          + 'Monitor the independent protected Action publication; selection is pending, not clearance.' },
      asynchronous ? { triggerTurn: true, deliverAs: 'followUp' } : undefined);
    }
  };
  const schedule = (ctx: any): void => {
    const active = round ?? pending;
    if (pending && Date.now() - pending.startedAt > 10 * 60_000) {
      pi.sendMessage({ customType: 'pr-boundary-remote-unavailable', display: true,
        content: 'Protected Review preparation did not resolve within ten minutes. No local fallback or clearance.' });
      stop(); return;
    }
    if (timer || !active || Date.now() - active.startedAt > 2 * 60 * 60_000
      || round && (!branchHasPlan(ctx, round) || alreadyDelivered(ctx, round))
      || pending && !samePending(pendingMarker(ctx), pending)) return;
    timer = setTimeout(async () => {
      timer = undefined;
      try {
        if (pending && samePending(pendingMarker(ctx), pending)) {
          const waiting = pending;
          const observedEpoch = epoch;
          const selection = await dependencies.selectBoundary(waiting, true);
          if (observedEpoch !== epoch) return;
          const current = await dependencies.currentBoundary({ type: 'session_start' }, ctx);
          if (observedEpoch !== epoch) return;
          if (!samePending(pending, waiting) || !samePending(pendingMarker(ctx), waiting)
            || waiting.sessionFile && ctx.sessionManager.getSessionFile?.() !== waiting.sessionFile
            || !current || current.repository !== waiting.repository || current.repositoryId !== waiting.repositoryId
            || current.repo !== waiting.repo || current.pullRequest !== waiting.pullRequest || current.head !== waiting.head) {
            stop(); return;
          }
          if (selection.mode !== 'remote') {
            pi.sendMessage({ customType: 'pr-boundary-remote-unavailable', display: true,
              content: 'Protected Review selection became unavailable. No local fallback or clearance.' });
            stop(); return;
          }
          if (selection.activityId && id.test(selection.activityId)) activate(waiting, selection.activityId, ctx, true);
        }
        await inspect(ctx);
        schedule(ctx);
      } catch { stop(); /* A stale session cannot continue reading. */ }
    }, 30_000);
    timer.unref?.();
  };
  pi.on('session_start', async (_event, ctx) => {
    stop();
    const entry = ctx.sessionManager.getBranch().filter((item: any) => item.type === 'custom'
      && (item.customType === ROUND_ENTRY || item.customType === PENDING_ENTRY)).at(-1);
    const saved = entry?.data as Pending | undefined;
    if (!saved || !sha.test(saved.head) || !Number.isSafeInteger(saved.startedAt)
      || saved.sessionFile && saved.sessionFile !== ctx.sessionManager.getSessionFile?.()) return;
    if (entry.customType === PENDING_ENTRY) {
      if (Date.now() - saved.startedAt > 10 * 60_000) return;
      pending = saved;
    } else if ('activityId' in saved && id.test(String(saved.activityId))
      && Date.now() - saved.startedAt <= 2 * 60 * 60_000) {
      round = saved as Round;
      await inspect(ctx);
    }
    schedule(ctx);
  });
  pi.on('session_shutdown', stop);
  pi.on('tool_result', async (event, ctx) => {
    if (!isBoundary(event, ctx) || (event as any).isError === true
      || (event as any).result?.isError === true) return;
    const observedEpoch = epoch;
    const revision = ++submissionEpoch;
    const boundary = await dependencies.currentBoundary(event, ctx);
    if (observedEpoch !== epoch || revision !== submissionEpoch || !boundary || !sha.test(boundary.head) || !Number.isSafeInteger(boundary.repositoryId)
      || !Number.isSafeInteger(boundary.pullRequest)) return;
    const rejectedFindings = eligibleRejections(ctx, boundary);
    const selected = await dependencies.selectBoundary(rejectedFindings
      ? { ...boundary, rejectedFindings } : boundary);
    if (observedEpoch !== epoch || revision !== submissionEpoch) return;
    if (selected.mode !== 'remote' || selected.activityId && !id.test(selected.activityId)) {
      pi.sendMessage({ customType: 'pr-boundary-remote-unavailable', display: true,
        content: 'Protected Review is unavailable; do not start local reviewers or claim clearance.' });
      return;
    }
    const current = await dependencies.currentBoundary(event, ctx);
    if (observedEpoch !== epoch || revision !== submissionEpoch || !current || current.repository !== boundary.repository || current.repositoryId !== boundary.repositoryId
      || current.pullRequest !== boundary.pullRequest || current.head !== boundary.head) return;
    if (!selected.activityId) {
      const prior = pendingMarker(ctx);
      if (!prior || prior.repository !== boundary.repository || prior.pullRequest !== boundary.pullRequest
        || prior.head !== boundary.head || prior.sessionFile !== ctx.sessionManager.getSessionFile?.()) {
        epoch += 1;
        pending = { ...boundary, sessionFile: ctx.sessionManager.getSessionFile?.(), startedAt: Date.now() };
        pi.appendEntry(PENDING_ENTRY, pending);
        pi.sendMessage({ customType: 'pr-boundary-remote-pending', display: true,
          content: 'Protected Review preparation is pending. Reconcile read-only; do not repeat staging '
            + 'or fall back to local reviewers.' });
      } else pending = prior;
      schedule(ctx);
      return;
    }
    activate(boundary, selected.activityId, ctx);
    schedule(ctx);
  });
  pi.on('agent_settled', async (_event, ctx) => {
    await inspect(ctx);
    schedule(ctx);
  });
  pi.on('agent_end', (_event, ctx) => {
    const active = round;
    if (!active || !branchHasPlan(ctx, active)) return;
    const entries = ctx.sessionManager.getBranch();
    const delivered = entries.reduce((last: number, entry: any, index: number) =>
      entry.type === 'custom_message' && entry.customType === 'pr-boundary-original-findings'
        && entry.details?.activityId === active.activityId && entry.details?.head === active.head
        ? index : last, -1);
    if (delivered < 0 || entries.some((entry: any) => entry.type === 'custom'
      && entry.customType === 'operator-review-remote-fix'
      && entry.data?.activityId === active.activityId && entry.data?.head === active.head)) return;
    const report = entries[delivered];
    const findings = report.details?.findings;
    if (!Array.isArray(findings) || report.details?.omittedFindings
      || findings.some((finding: any) => String(finding.message).includes('[truncated]')
        || String(finding.evidence).includes('[truncated]'))) return;
    const after = entries.slice(delivered + 1);
    const assistant = after.filter((entry: any) => entry.type === 'message'
      && entry.message?.role === 'assistant').at(-1)?.message;
    const text: string = Array.isArray(assistant?.content) ? assistant.content
      .filter((part: any) => part.type === 'text').map((part: any) => String(part.text ?? '')).join('\n') : '';
    const lines = text.split('\n').map(line => line.trim());
    const table = lines.findIndex((line, index) => line === REVIEW_TRIAGE_HEADER
      && lines[index + 1] === REVIEW_TRIAGE_DIVIDER);
    if (table < 0 || !findings.every((finding: any) => lines.slice(table + 2).some(line => {
      const cells = line.split('|').map(cell => cell.trim());
      return cells.length === 7 && cells[1] === finding.id
        && /^(?:accepted|rejected)\b/i.test(cells[5] ?? '');
    }))) return;
    const ci = ciTerminal(ctx, active);
    if (!ci || ci !== 'success' && !lines.slice(table + 2).some(line =>
      line.startsWith('| Exact-head CI |') && line.includes(`CI_RESULT ${ci}`))) return;
    const rejectedFindings: RejectedFinding[] = [];
    for (const finding of findings) {
      const row = lines.slice(table + 2).map(line => line.split('|').map(cell => cell.trim()))
        .find(cells => cells.length === 7 && cells[1] === finding.id
          && /^rejected\b/i.test(cells[5] ?? ''));
      if (!row) continue;
      const rationale = row[2]?.replace(/^Rejected:\s*/i, '').trim();
      const evidence = row[4]?.trim();
      if (!rationale || rationale.length > 2048 || !evidence || evidence.length > 2048
        || !id.test(finding.id)) return;
      rejectedFindings.push({ findingId: finding.id, priorActivityId: active.activityId,
        priorRound: report.details.round, priorHead: active.head,
        originalReportDigest: report.details.artifactDigest, rationale, evidence });
    }
    if (rejectedFindings.length) pi.appendEntry(REJECTIONS_ENTRY, { repository: active.repository,
      repositoryId: active.repositoryId, pullRequest: active.pullRequest, repo: active.repo,
      sessionFile: active.sessionFile, head: active.head, rejectedFindings });
    pi.appendEntry('operator-review-remote-fix', { activityId: active.activityId, head: active.head,
      artifactDigest: report.details.artifactDigest, round: report.details.round });
    pi.sendMessage({ customType: 'pr-boundary-fix-follow-up', display: true,
      content: 'Joint protected Review and exact-head CI triage is recorded. In a separate FIX phase, '
        + 'apply only accepted minimal corrections; do not mark this remote Review complete or '
        + 'resolve rejected findings without independent next-round reassessment.' },
    { triggerTurn: true, deliverAs: 'followUp' });
  });
}

function githubRepository(value: string): string | undefined {
  const ssh = /^git@github\.com:([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(value);
  if (ssh) return ssh[1]!.toLowerCase();
  try {
    const url = new URL(value);
    if (url.hostname !== 'github.com' || url.password || url.port || url.search || url.hash
      || !['https:', 'ssh:'].includes(url.protocol)
      || url.username && !(url.protocol === 'ssh:' && url.username === 'git')) return;
    const match = /^\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url.pathname);
    return match?.[1]?.toLowerCase();
  } catch { return; }
}
function createdPullRequest(event: any): { repository: string; number: number; url: string } | undefined {
  const text = (value: any): string => typeof value === 'string' ? value
    : Array.isArray(value) ? value.map(text).join('\n')
      : value && typeof value === 'object' ? ['text', 'content', 'stdout', 'result']
        .map(key => text(value[key])).join('\n') : '';
  const urls = [...new Set(text(event).split(/\r?\n/).map(line => line.trim())
    .filter(line => /^https:\/\/[^/\s]+\/[^/\s]+\/[^/\s]+\/pull\/[1-9]\d*\/?$/.test(line)))];
  if (urls.length !== 1) return;
  const url = new URL(urls[0]!);
  if (url.hostname !== 'github.com' || url.username || url.password || url.port) return;
  const [, owner, repo, , number] = url.pathname.split('/');
  return { repository: `${owner}/${repo}`.toLowerCase(), number: Number(number), url: url.href };
}
export async function currentOperatorBoundary(event: any, ctx: any,
  runner: typeof execFile = execFile): Promise<Boundary | undefined> {
  const invocation = shellInvocations(event, ctx.cwd).filter(item =>
    Boolean(classifyReviewBoundaryCommand(item.command).event)).at(-1);
  if (event?.type === 'tool_result' && !invocation) return;
  const saved = !invocation && typeof ctx.sessionManager?.getBranch === 'function'
    ? ctx.sessionManager.getBranch().filter((entry: any) => entry.type === 'custom'
      && (entry.customType === ROUND_ENTRY || entry.customType === PENDING_ENTRY)).at(-1)?.data?.repo
    : undefined;
  const repo = invocation ? resolveShellInvocationRepo(invocation)
    : findGitRoot(ctx.cwd) ?? (saved ? findGitRoot(saved) : undefined)
      ?? (recallActiveRepo() ? findGitRoot(recallActiveRepo()!) : undefined);
  if (!repo) return;
  try {
    const options = { cwd: repo, encoding: 'utf8' as const, timeout: 10_000 };
    const [{ stdout: branchText }, { stdout: headText }, { stdout: identity }, { stdout: idText }] = await Promise.all([
      runner('git', ['symbolic-ref', '--quiet', '--short', 'HEAD'], options),
      runner('git', ['rev-parse', 'HEAD'], options),
      runner('gh', ['repo', 'view', '--json', 'nameWithOwner,url'], options),
      runner('gh', ['api', 'repos/{owner}/{repo}', '--jq', '.id'], options),
    ]);
    const branch = String(branchText).trim(), localHead = String(headText).trim();
    if (!branch || !sha.test(localHead)) return;
    const target = JSON.parse(String(identity));
    const operation = invocation && classifyReviewBoundaryCommand(invocation.command).kind;
    const words = invocation && executableShellCommands(invocation.command).filter(row =>
      ['git', 'gh'].includes(shellCommandExecutable(row) ?? '')).at(-1);
    const executable = words && shellCommandExecutable(words);
    const args = words && (executable === 'git' || executable === 'gh')
      ? shellCommandArguments(words, executable) : [];
    if (executable === 'gh') {
      // Repository selectors can precede or follow the PR operation.
      for (let index = 0; index < words!.length; index += 1) {
        const word = words![index]!;
        const repository = word === '-R' || word === '--repo' ? words![++index]
          : word.startsWith('--repo=') ? word.slice(7) : undefined;
        if (repository !== undefined && repository.toLowerCase() !== target.nameWithOwner.toLowerCase()) return;
      }
    }
    const created = operation === 'pr-create' ? createdPullRequest(event) : undefined;
    // A create result naming a different PR/host must not become the current checkout's PR.
    if (operation === 'pr-create' && !created) return;
    if (created && created.repository !== target.nameWithOwner.toLowerCase()) return;
    let selector = created?.url ?? branch;
    if (operation === 'pr-reopen') {
      const positional: string[] = [];
      for (let index = 2; index < args.length; index += 1) {
        const arg = args[index]!;
        if (['-R', '--repo', '-c', '--comment'].includes(arg)) { index += 1; continue; }
        if (!arg.startsWith('-')) positional.push(arg);
      }
      if (positional.length > 1) return;
      selector = positional[0] ?? branch;
      if (selector.startsWith('https://') && (!selector.startsWith('https://github.com/')
        || !/^https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/[1-9]\d*\/?$/.test(selector))) return;
    }
    const { stdout: prText } = await runner('gh', ['pr', 'view', selector, '--json',
      'number,state,baseRefName,headRefName,headRefOid,headRepository'], options);
    const pr = JSON.parse(String(prText));
    const repositoryId = Number(String(idText).trim());
    if (new URL(target.url).hostname !== 'github.com'
      || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(target.nameWithOwner)
      || !Number.isSafeInteger(repositoryId) || repositoryId < 1
      || !Number.isSafeInteger(pr.number) || pr.number < 1 || pr.state !== 'OPEN'
      || !['main', 'master', 'develop'].includes(pr.baseRefName) || !sha.test(pr.headRefOid)
      || pr.headRefName !== branch || pr.headRefOid !== localHead
      || created && pr.number !== created.number
      || invocation && !exposureTargetsCheckedOutBranch(invocation.command,
        { branch, pr: pr.number, repository: target.nameWithOwner })) return;
    if (operation === 'pr-create') {
      const inline = args.find(arg => arg.startsWith('--head='))?.slice(7);
      const index = args.findIndex(arg => arg === '--head' || arg === '-H');
      const head = inline ?? (index >= 0 ? args[index + 1] : undefined);
      const owner = (pr.headRepository?.nameWithOwner ?? target.nameWithOwner).split('/')[0];
      if (head && head !== branch && head !== `${owner}:${branch}`) return;
    }
    if (operation === 'push') {
      const positional: string[] = [];
      let remote: string | undefined;
      for (let index = 1; index < args.length; index += 1) {
        const arg = args[index]!;
        if (arg === '--repo') { remote = args[++index]; continue; }
        if (arg.startsWith('--repo=')) { remote = arg.slice(7); continue; }
        if (['--receive-pack', '--exec', '--push-option', '-o'].includes(arg)) { index += 1; continue; }
        if (arg === '--') { positional.push(...args.slice(index + 1)); break; }
        if (!arg.startsWith('-') && !/^\d*[<>]&\d+$/.test(arg)) positional.push(arg);
      }
      remote ??= positional[0];
      if (!remote) {
        for (const key of [`branch.${branch}.pushRemote`, 'remote.pushDefault', `branch.${branch}.remote`]) {
          const configured = await runner('git', ['config', '--get', key], options).catch(() => undefined);
          remote = configured && String(configured.stdout).trim() || undefined;
          if (remote) break;
        }
      }
      if (!remote) return;
      const url = githubRepository(remote) ? remote
        : String((await runner('git', ['remote', 'get-url', '--push', remote], options)).stdout).trim();
      if (githubRepository(url) !== (pr.headRepository?.nameWithOwner ?? target.nameWithOwner).toLowerCase()) return;
    }
    return { repository: target.nameWithOwner, repositoryId, pullRequest: pr.number,
      head: pr.headRefOid, repo };
  } catch { return; }
}
function parseSelection(output: string, boundary: Boundary): Selection {
  const text = output.replace(/\r\n/g, '\n');
  const split = text.indexOf('\n\n');
  if (text.length > 256 * 1024 || split < 0
    || !/^HTTP\/(?:1\.1|2(?:\.0)?|3) 200(?:\s|$)/.test(text)) return { mode: 'unavailable' };
  const headers = text.slice(0, split).split('\n');
  const selected = headers.filter(line => /^x-codeflare-operator-boundary-selection:/i.test(line));
  const activities = headers.filter(line => /^x-codeflare-operator-boundary-activity:/i.test(line));
  if (selected.length !== 1 || selected[0]!.split(':').slice(1).join(':').trim() !== 'remote'
    || activities.length > 1) return { mode: 'unavailable' };
  const activityId = activities[0]?.split(':').slice(1).join(':').trim();
  try {
    const pr = JSON.parse(text.slice(split + 2));
    return pr.number === boundary.pullRequest && pr.head?.sha === boundary.head
      && (!activityId || id.test(activityId))
      ? { mode: 'remote', ...(activityId ? { activityId } : {}) } : { mode: 'unavailable' };
  } catch { return { mode: 'unavailable' }; }
}
export async function selectOperatorBoundary(boundary: Boundary,
  readOnly = false, runner: typeof execFile = execFile): Promise<Selection> {
  const rejected = boundary.rejectedFindings;
  const valid = Array.isArray(rejected) && rejected.length > 0 && rejected.length <= 20
    && rejected.every(row => id.test(row.findingId) && id.test(row.priorActivityId)
      && Number.isSafeInteger(row.priorRound) && row.priorRound > 0 && sha.test(row.priorHead)
      && row.priorHead !== boundary.head && /^[a-f0-9]{64}$/i.test(row.originalReportDigest)
      && typeof row.rationale === 'string' && row.rationale.length > 0 && row.rationale.length <= 2048
      && typeof row.evidence === 'string' && row.evidence.length > 0 && row.evidence.length <= 2048)
    && rejected.every(row => row.priorHead === rejected[0]!.priorHead);
  const encoded = Buffer.from(JSON.stringify({ repositoryId: boundary.repositoryId,
    pullRequest: boundary.pullRequest, acknowledgedHead: valid ? rejected[0]!.priorHead : null,
    targetHead: boundary.head, payload: { range: null,
      ...(valid ? { rejectedFindings: rejected.map(row => ({ findingId: row.findingId,
        priorActivityId: row.priorActivityId, priorRound: row.priorRound, priorHead: row.priorHead,
        originalReportDigest: row.originalReportDigest, rationale: row.rationale, evidence: row.evidence })) }
        : { rejectedFindingsStatus: 'unavailable' }) } }), 'utf8').toString('base64');
  const read = async (mode: '1' | 'check') => {
    const { stdout } = await runner('gh', ['api', '--include',
      '-H', `x-codeflare-operator-boundary-select: ${mode}`,
      '-H', `x-codeflare-operator-boundary-input: ${encoded}`,
      `repos/${boundary.repository}/pulls/${boundary.pullRequest}`],
    { cwd: boundary.repo, encoding: 'utf8', timeout: 20_000 });
    return parseSelection(String(stdout), boundary);
  };
  try {
    const initial = await read(readOnly ? 'check' : '1');
    if (initial.mode !== 'remote' || initial.activityId || readOnly) return initial;
    // The accepted staging response may not yet expose its Activity. Reconcile
    // once by read-only selection, then retain pending state for the monitor.
    return await read('check');
  } catch { return { mode: 'unavailable' }; }
}
async function readPublishedResult(boundary: Boundary, activityId: string): Promise<unknown> {
  const { stdout } = await execFile('gh', ['api', '-H', `x-codeflare-operator-boundary-result: ${activityId}`,
    `repos/${boundary.repository}/pulls/${boundary.pullRequest}`],
  { cwd: boundary.repo, encoding: 'utf8', timeout: 20_000, maxBuffer: 128 * 1024 });
  return JSON.parse(String(stdout));
}
export default function operatorReviewRemote(pi: ExtensionAPI): void {
  registerOperatorReviewRemote(pi, { currentBoundary: currentOperatorBoundary,
    selectBoundary: selectOperatorBoundary, readPublishedResult });
}
