#!/usr/bin/env node

// The threshold has always been deterministic; the count feeding it was not.
// Two runtimes reading the same rule produced 0 and 3 on a window whose true
// count was 1, so the count is computed here rather than by the reader.

import { execFileSync } from 'node:child_process';

const COUNTED = ['[autonomous]', '[unleashed]', '[spec-reviewer]', '[doc-updater]', '[code-reviewer]'];
const EXCLUDED = ['[sdd-clean]', '[sdd-init]', '[sdd-triage]'];
const WINDOW = 6;
const LIMIT = 5;

function action(countedCommits, autonomyOverride) {
  return countedCommits >= LIMIT && autonomyOverride !== 'fully-autonomous' ? 'stop' : 'continue';
}

// Newest first. A counted tag that touched the lane is a round; an excluded tag
// is an intentional bulk op and is neither; a plain commit in the lane is
// user-directed work, which closes the window -- anything older is a prior cycle.
function countRounds(repo, lane) {
  // NUL-delimited: a commit subject may itself contain any printable delimiter,
  // and a phantom block is the same miscount this script exists to remove.
  const log = execFileSync('git', ['log', `-${WINDOW}`, '--name-only', '--format=%x00%H %s'], {
    cwd: repo,
    encoding: 'utf8',
  });

  let counted = 0;
  for (const block of log.split('\0').slice(1)) {
    const lines = block.split('\n');
    const subject = lines[0].slice(lines[0].indexOf(' ') + 1);
    const touchedLane = lines.slice(1).some((file) => file && file.startsWith(lane));

    if (COUNTED.some((tag) => subject.startsWith(tag))) {
      if (touchedLane) counted += 1;
    } else if (EXCLUDED.some((tag) => subject.startsWith(tag))) {
      continue;
    } else if (touchedLane) {
      break;
    }
  }
  return counted;
}

const argv = process.argv.slice(2);
const autonomyOverride = argv.includes('fully-autonomous') ? 'fully-autonomous' : undefined;
const repoIndex = argv.indexOf('--repo');

if (repoIndex === -1) {
  const countedCommits = Number(argv[0]);
  if (!Number.isInteger(countedCommits) || countedCommits < 0) {
    process.stderr.write('counted commits must be a non-negative integer\n');
    process.exit(2);
  }
  process.stdout.write(`${action(countedCommits, autonomyOverride)}\n`);
} else {
  const repo = argv[repoIndex + 1];
  const laneIndex = argv.indexOf('--lane');
  const lane = laneIndex === -1 ? undefined : argv[laneIndex + 1];
  if (!repo || !lane) {
    process.stderr.write('--repo <dir> and --lane <path-prefix> are both required\n');
    process.exit(2);
  }
  let counted;
  try {
    counted = countRounds(repo, lane);
  } catch (error) {
    // Never leave the caller a stack trace where it expects a verdict.
    process.stderr.write(`cannot read git history in ${repo}: ${error.message.split('\n')[0]}\n`);
    process.exit(2);
  }
  process.stdout.write(`counted=${counted} gate=${action(counted, autonomyOverride)}\n`);
}
