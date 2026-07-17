#!/usr/bin/env node

const countedCommits = Number(process.argv[2]);
const autonomyOverride = process.argv[3];

if (!Number.isInteger(countedCommits) || countedCommits < 0) {
  process.stderr.write('counted commits must be a non-negative integer\n');
  process.exit(2);
}

const action = countedCommits >= 5 && autonomyOverride !== 'fully-autonomous'
  ? 'stop'
  : 'continue';
process.stdout.write(`${action}\n`);
