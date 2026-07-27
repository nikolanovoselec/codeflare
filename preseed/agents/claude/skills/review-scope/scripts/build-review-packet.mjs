#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const LANES = new Set(['code-reviewer', 'spec-reviewer', 'doc-updater']);
const ROOT_DOC = /^(README|CHANGELOG|CONTRIBUTING|SECURITY)\.md$|^LICENSE$/;
const FULL_SHA = /^[0-9a-f]{40}$/;
const BOOLEAN_FLAGS = new Set(['with-evidence']);

function git(repo, args, encoding = 'utf8') {
  return execFileSync('git', args, {
    cwd: repo,
    encoding,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 256 * 1024 * 1024,
  });
}

function isGenerated(path) {
  return path.startsWith('graphify-out/')
    || path.includes('/node_modules/')
    || /(^|\/)(dist|build|coverage)\//.test(path)
    || path === 'src/lib/agent-seed.generated.ts';
}

function owns(lane, path) {
  if (isGenerated(path)) return false;
  if (lane === 'spec-reviewer') return path.startsWith('sdd/');
  if (lane === 'doc-updater') return path.startsWith('documentation/') || ROOT_DOC.test(path);
  return !path.startsWith('sdd/') && !path.startsWith('documentation/') && !ROOT_DOC.test(path);
}

function nulList(buffer) {
  return buffer.toString('utf8').split('\0').filter(Boolean).sort();
}

function changedHunks(repo, range, path) {
  const patch = String(git(repo, ['diff', '--no-renames', '--unified=0', range, '--', path]));
  return [...patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)].map((match) => ({
    oldStart: Number(match[1]),
    oldLines: match[2] === undefined ? 1 : Number(match[2]),
    newStart: Number(match[3]),
    newLines: match[4] === undefined ? 1 : Number(match[4]),
  }));
}

function validateRange(repo, range) {
  const [base, head, extra] = String(range ?? '').split('..');
  if (extra !== undefined || !FULL_SHA.test(base ?? '') || !FULL_SHA.test(head ?? '')) {
    throw new Error('diff scope requires a valid ancestor range');
  }
  try {
    git(repo, ['merge-base', '--is-ancestor', base, head]);
  } catch {
    throw new Error('diff scope requires a valid ancestor range');
  }
  return `${base}..${head}`;
}

function intersects(start, lines, rangeStart, rangeEnd) {
  return lines > 0 && start <= rangeEnd && start + lines - 1 >= rangeStart;
}

export function changedInputIntersects(input, range) {
  return input.hunks.some((hunk) =>
    (range.oldStart !== undefined
      && range.oldEnd !== undefined
      && intersects(hunk.oldStart, hunk.oldLines, range.oldStart, range.oldEnd))
    || (range.newStart !== undefined
      && range.newEnd !== undefined
      && intersects(hunk.newStart, hunk.newLines, range.newStart, range.newEnd)),
  );
}

export function buildReviewPacket({ repo, scope, range, lane }) {
  if (scope !== 'diff' && scope !== 'all') throw new Error('scope must be diff or all');
  if (!LANES.has(lane)) throw new Error('lane must be code-reviewer, spec-reviewer, or doc-updater');

  if (scope === 'all') {
    const tracked = nulList(git(repo, ['ls-files', '-z'], 'buffer'));
    return {
      scope,
      workSet: 'whole-requested-tree',
      lane,
      range: undefined,
      files: tracked.filter((path) => owns(lane, path)),
      changedInputs: [],
      patch: '',
    };
  }

  const validRange = validateRange(repo, range);
  const changed = nulList(git(repo, ['diff', '--name-only', '--no-renames', '-z', validRange], 'buffer'))
    .filter((path) => !isGenerated(path));
  const files = changed.filter((path) => owns(lane, path));
  const patch = files.length === 0
    ? ''
    : String(git(repo, ['diff', '--no-renames', '--unified=3', validRange, '--', ...files]));
  const changedInputs = changed
    .filter((path) => !files.includes(path))
    .map((path) => ({ path, hunks: changedHunks(repo, validRange, path) }));
  return {
    scope,
    workSet: 'changed-hunks-and-direct-invalidations',
    lane,
    range: validRange,
    files,
    changedInputs,
    patch,
  };
}

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key?.startsWith('--')) continue;
    // A valueless flag must not swallow the flag after it. Consuming blindly
    // turned `--with-evidence --lane doc-updater` into a packet with no lane.
    // Only a KNOWN valueless flag becomes true; anything else keeps its missing
    // value undefined so the validation below names the flag rather than
    // reporting a boolean as a lane.
    const name = key.slice(2);
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      values[name] = BOOLEAN_FLAGS.has(name) ? true : undefined;
      continue;
    }
    values[key.slice(2)] = next;
    index += 1;
  }
  return values;
}

// The SAME bound the lane runner applies (`run-review-lane.sh`, 300s). They were
// 300s and 60s, so one resolver could succeed for the runtime with a runner and
// fail for the runtime without one -- which is exactly what happened: the
// documentation lane's resolver sat at 283s, inside the runner's bound and past
// this one, so that lane silently lost its evidence on every boundary event in
// one runtime and kept it in the other. A bound that differs by transport turns
// a shared program into two different programs.
//
// Read from the same environment variable, with the same clamp, for the same
// reason: parity that holds only at the default is not parity. An operator
// raising the runner's bound would otherwise leave this one at 300s and
// recreate the split this constant exists to close. The runner's value is
// seconds; the clamp rejects a non-numeric, zero or absurdly long value and
// falls back rather than wrapping.
const EVIDENCE_TIMEOUT_MS = ((raw) => (
  /^[0-9]{1,9}$/.test(raw ?? '') && Number(raw) > 0 ? Number(raw) * 1000 : 300_000
))(process.env.REVIEW_LANE_EVIDENCE_TIMEOUT);

// A runtime with a lane runner has its evidence inlined for it. A runtime
// without one has to ask, and asking meant a second command beside this one.
// Folding it in makes a single invocation carry both, so there is no second
// instruction to follow. Best-effort by construction -- no evidence degrades to
// the lane gathering its own, never to a skipped check.
function laneEvidence(repo, lane, range) {
  try {
    const script = new URL('./lane-evidence.mjs', import.meta.url);
    const out = execFileSync(process.execPath, [
      script.pathname, '--repo', repo, '--lane', lane, ...(range ? ['--range', range] : []),
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 32 * 1024 * 1024,
      // The resolver runs many greps. The other runtime bounds it with timeout(1);
      // without this, a hang here holds the packet call open with nothing to show.
      timeout: EVIDENCE_TIMEOUT_MS,
    });
    return { evidence: JSON.parse(out) };
  } catch (error) {
    // Naming the failure rather than dropping the key. An absent `evidence` was
    // indistinguishable from one never asked for, so a resolver that exceeded
    // the bound above on every run of one lane read as "this lane has no
    // evidence" and nothing surfaced it -- not a log, not a field, and stderr is
    // discarded here by design. The lane can act on a reason; it cannot act on a
    // key that is simply missing.
    const reason = error?.signal === 'SIGTERM' || error?.code === 'ETIMEDOUT'
      ? `resolver exceeded ${EVIDENCE_TIMEOUT_MS}ms`
      : `resolver failed: ${String(error?.message ?? error).split('\n')[0].slice(0, 200)}`;
    return { omitted: reason };
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    const packet = buildReviewPacket({
      repo: args.repo,
      scope: args.scope,
      range: args.range,
      lane: args.lane,
    });
    if ('with-evidence' in args) {
      const resolved = laneEvidence(args.repo, args.lane, packet.range);
      if (resolved.evidence) packet.evidence = resolved.evidence;
      else packet.evidenceOmitted = resolved.omitted;
    }
    process.stdout.write(`${JSON.stringify(packet)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
