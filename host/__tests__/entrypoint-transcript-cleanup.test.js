// REQ-STOR-012: Main Session Transcript Cleanup
//
// Behavioral coverage for Claude Code and Pi main-transcript retention.
// Native subagent/task transcripts and Codex state are outside this cleanup.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, '..', '..');
const ENTRYPOINT = join(REPO_ROOT, 'entrypoint.sh');
const RETENTION_SCRIPT = join(REPO_ROOT, 'transcript-retention.mjs');

function extractShellFunction(name) {
  const body = readFileSync(ENTRYPOINT, 'utf8');
  const start = body.indexOf(`${name}() {`);
  assert.notEqual(start, -1, `${name} must exist in entrypoint.sh`);
  const rest = body.slice(start);
  const close = rest.search(/\n\}\n/);
  assert.notEqual(close, -1, `${name} must have a closing brace`);
  return rest.slice(0, close + 3);
}

function makeScratch() {
  const dir = mkdtempSync(join(tmpdir(), 'transcript retention '));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function uuid(index) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
}

function setMtime(path, seconds) {
  utimesSync(path, seconds, seconds);
}

function writeClaude(root, index, nativeSecond, mtimeSecond, options = {}) {
  const id = uuid(index);
  const project = options.project ?? join(root, `project ${index % 2}`, 'nested');
  mkdirSync(project, { recursive: true });
  const path = join(project, `${id}.jsonl`);
  const records = [
    JSON.stringify({ type: 'last-prompt', sessionId: id }),
    JSON.stringify({
      type: 'user',
      sessionId: id,
      version: options.version ?? '2.1.224',
      isSidechain: false,
      timestamp: `2026-08-18T10:00:${String(nativeSecond).padStart(2, '0')}.000Z`,
    }),
  ];
  if (options.malformedInterior) records.push('{malformed');
  records.push(JSON.stringify({
    type: 'assistant',
    sessionId: id,
    version: options.version ?? '2.1.224',
    isSidechain: false,
    timestamp: `2026-08-18T10:01:${String(nativeSecond).padStart(2, '0')}.000Z`,
  }));
  if (options.malformedTail) records.push('{partial');
  writeFileSync(path, `${records.join('\n')}\n`);
  setMtime(path, mtimeSecond);
  return path;
}

function writePi(root, index, nativeSecond, mtimeSecond, options = {}) {
  const id = uuid(index);
  const sessionDir = options.sessionDir ?? join(root, `workspace ${index % 2}`, 'nested');
  mkdirSync(sessionDir, { recursive: true });
  const path = join(sessionDir, `2026-08-18T10-00-${String(index).padStart(2, '0')}Z_${id}.jsonl`);
  const records = [JSON.stringify({
    type: 'session',
    version: options.version ?? 3,
    id,
    timestamp: `2026-08-18T10:00:${String(nativeSecond).padStart(2, '0')}.000Z`,
  })];
  if (options.malformedInterior) records.push('{malformed');
  records.push(JSON.stringify({
    type: 'message',
    timestamp: `2026-08-18T10:01:${String(nativeSecond).padStart(2, '0')}.000Z`,
  }));
  if (options.malformedTail) records.push('{partial');
  writeFileSync(path, `${records.join('\n')}\n`);
  setMtime(path, mtimeSecond);
  return path;
}

function runRetention(agent, root) {
  return execFileSync(process.execPath, [RETENTION_SCRIPT, agent, root, '10'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

function transcriptNames(root) {
  const names = [];
  const visit = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.name.endsWith('.jsonl')) names.push(entry.name);
    }
  };
  visit(root);
  return names.sort();
}

describe('main transcript retention / REQ-STOR-012', () => {
  test('AC1: regular bisync observes the already-pruned transcript set', () => {
    const scratch = makeScratch();
    try {
      const claude = join(scratch.dir, '.claude', 'projects');
      for (let i = 0; i < 12; i++) writeClaude(claude, i, i, 8_000 + (11 - i));
      const events = join(scratch.dir, 'events');
      const shell = `set +e
USER_HOME='${scratch.dir}'
R2_BUCKET_NAME=test
RCLONE_CONFIG=/dev/null
RECOVERY_FILTER_FILE=/dev/null
RCLONE_FILTERS=()
TRANSCRIPT_RETENTION_SCRIPT='${RETENTION_SCRIPT}'
EVENTS='${events}'
repair_hook_exec_bits() { :; }
pgrep() { return 1; }
rclone() {
  find "$USER_HOME/.claude/projects" -type f -name '*.jsonl' | wc -l >> "$EVENTS"
  return 1
}
${extractShellFunction('cleanup_agent_transcripts')}
${extractShellFunction('cleanup_old_transcripts')}
${extractShellFunction('cleanup_old_pi_transcripts')}
${extractShellFunction('bisync_with_r2')}
bisync_with_r2 '' || true
`;

      execFileSync('bash', ['-c', shell], { stdio: ['ignore', 'pipe', 'pipe'] });

      assert.equal(readFileSync(events, 'utf8').trim(), '10');
    } finally {
      scratch.cleanup();
    }
  });

  test('AC2: Claude and Pi independently keep ten main transcripts by native activity across nested folders', () => {
    const scratch = makeScratch();
    try {
      const claude = join(scratch.dir, '.claude', 'projects');
      const pi = join(scratch.dir, '.pi', 'agent', 'sessions');
      const claudePaths = [];
      const piPaths = [];
      for (let i = 0; i < 12; i++) {
        claudePaths.push(writeClaude(claude, i, i, 10_000 + (11 - i)));
        piPaths.push(writePi(pi, i, i, 20_000 + (11 - i)));
      }

      runRetention('claude', claude);
      runRetention('pi', pi);

      assert.deepEqual(claudePaths.filter(existsSync).map((p) => Number(basename(p).slice(24, 36))).sort((a, b) => a - b), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
      assert.deepEqual(piPaths.filter(existsSync).map((p) => Number(basename(p).match(/(\d{12})\.jsonl$/)[1])).sort((a, b) => a - b), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    } finally {
      scratch.cleanup();
    }
  });

  test('AC3: malformed interior and trailing records do not hide a recoverable native timestamp', () => {
    const scratch = makeScratch();
    try {
      const claude = join(scratch.dir, '.claude', 'projects');
      const paths = [];
      for (let i = 0; i < 12; i++) {
        paths.push(writeClaude(claude, i, i, 30_000 + (11 - i), {
          malformedInterior: i === 11,
          malformedTail: i === 11,
        }));
      }

      const output = runRetention('claude', claude);

      assert.match(output, /mode=native/);
      assert.deepEqual(paths.filter(existsSync).map((p) => Number(basename(p).slice(24, 36))).sort((a, b) => a - b), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    } finally {
      scratch.cleanup();
    }
  });

  test('AC4: one unsupported main transcript switches the entire agent to deterministic mtime retention', () => {
    const scratch = makeScratch();
    try {
      const pi = join(scratch.dir, '.pi', 'agent', 'sessions');
      const paths = [];
      for (let i = 0; i < 12; i++) {
        paths.push(writePi(pi, i, 11 - i, 40_000 + i, { version: i === 5 ? 4 : 3 }));
      }

      const output = runRetention('pi', pi);

      assert.match(output, /mode=mtime-fallback/);
      assert.deepEqual(paths.filter(existsSync).map((p) => Number(basename(p).match(/(\d{12})\.jsonl$/)[1])).sort((a, b) => a - b), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    } finally {
      scratch.cleanup();
    }
  });

  test('AC5: Claude subagents, Pi tasks, and Codex state are untouched', () => {
    const scratch = makeScratch();
    try {
      const claude = join(scratch.dir, '.claude', 'projects');
      const pi = join(scratch.dir, '.pi', 'agent', 'sessions');
      const subagents = join(claude, 'project', uuid(99), 'subagents');
      const tasks = join(pi, 'workspace', `${uuid(98)}`, 'tasks');
      const codex = join(scratch.dir, '.codex');
      mkdirSync(subagents, { recursive: true });
      mkdirSync(tasks, { recursive: true });
      mkdirSync(codex, { recursive: true });
      const subagent = join(subagents, 'agent-child.jsonl');
      const task = join(tasks, 'task-child.jsonl');
      const codexState = join(codex, 'thread_history_1.sqlite');
      const outside = join(scratch.dir, `${uuid(97)}.jsonl`);
      const linkedCandidate = join(claude, `${uuid(96)}.jsonl`);
      writeFileSync(subagent, '{not a main transcript}\n');
      writeFileSync(task, '{not a main transcript}\n');
      writeFileSync(codexState, 'codex-state');
      writeFileSync(outside, 'outside-root');
      symlinkSync(outside, linkedCandidate);
      for (let i = 0; i < 12; i++) {
        writeClaude(claude, i, i, 50_000 + i);
        writePi(pi, i, i, 60_000 + i);
      }

      runRetention('claude', claude);
      runRetention('pi', pi);

      assert.equal(readFileSync(subagent, 'utf8'), '{not a main transcript}\n');
      assert.equal(readFileSync(task, 'utf8'), '{not a main transcript}\n');
      assert.equal(readFileSync(codexState, 'utf8'), 'codex-state');
      assert.equal(readFileSync(outside, 'utf8'), 'outside-root');
      assert.ok(existsSync(linkedCandidate), 'candidate symlink must be ignored, not followed or deleted');
    } finally {
      scratch.cleanup();
    }
  });

  test('AC6: ten or fewer transcripts are retained without parsing or deletion', () => {
    const scratch = makeScratch();
    try {
      const claude = join(scratch.dir, '.claude', 'projects');
      mkdirSync(claude, { recursive: true });
      for (let i = 0; i < 10; i++) writeFileSync(join(claude, `unknown ${i}.jsonl`), '{future schema}\n');

      const output = runRetention('claude', claude);

      assert.equal(transcriptNames(claude).length, 10);
      assert.equal(output, '');
    } finally {
      scratch.cleanup();
    }
  });

  test('AC7: equal native timestamps use the path as a stable tie-breaker', () => {
    const scratch = makeScratch();
    try {
      const claude = join(scratch.dir, '.claude', 'projects');
      const paths = [];
      for (let i = 0; i < 12; i++) paths.push(writeClaude(claude, i, 1, 70_000 + i));

      runRetention('claude', claude);

      const expected = [...paths].sort((a, b) => (a === b ? 0 : a > b ? -1 : 1)).slice(0, 10).sort();
      assert.deepEqual(paths.filter(existsSync).sort(), expected);
    } finally {
      scratch.cleanup();
    }
  });
});
