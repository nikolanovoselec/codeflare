// Verifies REQ-MEM-019: Post-compaction recall of recent session extracts.
//   AC1: injects the N most recent extracts, newest first, as additionalContext
//   AC2: ordering is by filename, not mtime (the vault round-trips through rclone)
//   AC3: fires only when the session started from compaction
//   AC4: each extract is capped, and the cap is visible as a truncation marker
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(
  __dirname,
  '../../preseed/agents/claude/plugins/codeflare-memory/scripts/post-compaction-recall.sh',
);

function extract(title, { context = 'ctx body', decisions = '- a decision' } = {}) {
  return [
    '---',
    'session_id: abc',
    '---',
    '',
    `# ${title}`,
    '',
    '## Context',
    context,
    '',
    '## Decisions',
    decisions,
    '',
    '## Observations',
    '- an observation that must NOT be injected',
    '',
  ].join('\n');
}

function seed(dir, files) {
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), body);
  }
}

function runHook({ sessionsDir, source = 'compact', count, perFileBytes }) {
  const result = spawnSync('bash', [HOOK], {
    encoding: 'utf-8',
    input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 's1', source }),
    env: {
      ...process.env,
      POST_COMPACT_SESSIONS_DIR: sessionsDir,
      ...(count ? { POST_COMPACT_EXTRACT_COUNT: String(count) } : {}),
      ...(perFileBytes ? { POST_COMPACT_PER_FILE_BYTES: String(perFileBytes) } : {}),
    },
  });
  const stdout = result.stdout.trim();
  let json = null;
  try { json = stdout ? JSON.parse(stdout) : null; } catch { json = null; }
  return {
    stdout,
    status: result.status,
    json,
    context: json?.hookSpecificOutput?.additionalContext ?? '',
  };
}

describe('post-compaction-recall.sh (REQ-MEM-019)', () => {
  let baseTmp;
  before(() => {
    baseTmp = mkdtempSync(join(tmpdir(), 'post-compact-'));
    assert.ok(existsSync(HOOK), `hook script missing at ${HOOK}`);
  });

  it('AC1: injects the N most recent extracts newest-first as SessionStart context', () => {
    const dir = join(baseTmp, 'ac1');
    seed(dir, {
      '2026-07-01T10-00-00+0200-aaa.md': extract('oldest session'),
      '2026-07-02T10-00-00+0200-bbb.md': extract('middle session'),
      '2026-07-03T10-00-00+0200-ccc.md': extract('newest session'),
    });

    const { status, json, context } = runHook({ sessionsDir: dir, count: 2 });

    assert.equal(status, 0);
    assert.equal(json?.hookSpecificOutput?.hookEventName, 'SessionStart');

    // The two newest are present and the third is not — proves the count bound
    // rather than merely that something was emitted.
    assert.ok(context.includes('newest session'));
    assert.ok(context.includes('middle session'));
    assert.ok(!context.includes('oldest session'));

    // Newest first: ordering is the contract, not just membership.
    assert.ok(context.indexOf('newest session') < context.indexOf('middle session'));

    // Context and Decisions are carried; Observations deliberately are not.
    assert.ok(context.includes('## Decisions'));
    assert.ok(!context.includes('must NOT be injected'));
  });

  it('AC2: orders by filename even when mtime disagrees', () => {
    const dir = join(baseTmp, 'ac2');
    seed(dir, {
      '2026-07-01T10-00-00+0200-old.md': extract('lexically oldest'),
      '2026-07-09T10-00-00+0200-new.md': extract('lexically newest'),
    });

    // rclone bisync rewrites mtimes, so make mtime claim the opposite order:
    // the oldest filename becomes the most recently modified file.
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(dir, '2026-07-01T10-00-00+0200-old.md'), future, future);

    const { context } = runHook({ sessionsDir: dir, count: 1 });

    assert.ok(context.includes('lexically newest'));
    assert.ok(!context.includes('lexically oldest'));
  });

  it('AC2: orders by captured instant across a UTC-offset change', () => {
    const dir = join(baseTmp, 'ac2-dst');
    seed(dir, {
      // 02:30+0100 is 01:30Z — the LATER instant, but the lower name as text.
      '2026-10-25T02-30-00+0100-a.md': extract('later instant'),
      // 02:45+0200 is 00:45Z — earlier, yet sorts above it lexically.
      '2026-10-25T02-45-00+0200-b.md': extract('earlier instant'),
    });

    const { context } = runHook({ sessionsDir: dir, count: 1 });

    assert.ok(context.includes('later instant'));
    assert.ok(!context.includes('earlier instant'));
  });

  it('AC3: stays silent unless the session started from compaction', () => {
    const dir = join(baseTmp, 'ac3');
    seed(dir, { '2026-07-03T10-00-00+0200-ccc.md': extract('a session') });

    for (const source of ['startup', 'resume', 'clear', 'fork']) {
      const { stdout, status } = runHook({ sessionsDir: dir, source });
      assert.equal(status, 0, `${source} must not fail the session`);
      assert.equal(stdout, '', `${source} must emit nothing`);
    }

    assert.notEqual(runHook({ sessionsDir: dir, source: 'compact' }).stdout, '');
  });

  it('AC4: caps each extract', () => {
    const dir = join(baseTmp, 'ac4');
    const marker = 'TAILEND';
    seed(dir, {
      '2026-07-03T10-00-00+0200-ccc.md': extract('big session', {
        decisions: `- ${'x'.repeat(4000)}\n- ${marker}`,
      }),
    });

    const { context } = runHook({ sessionsDir: dir, perFileBytes: 500 });

    assert.ok(context.includes('big session'));
    // The cap actually dropped content rather than only appending a notice.
    assert.ok(!context.includes(marker));
  });

  it('AC5: marks the truncation and keeps the source path', () => {
    const dir = join(baseTmp, 'ac5');
    const name = '2026-07-03T10-00-00+0200-ddd.md';
    seed(dir, {
      [name]: extract('capped session', { decisions: `- ${'y'.repeat(4000)}` }),
    });

    const { context } = runHook({ sessionsDir: dir, perFileBytes: 500 });

    assert.ok(context.includes('truncated'));
    // The path is what makes the dropped content recoverable.
    assert.ok(context.includes(join(dir, name)));
  });

  it('counts blocks actually emitted, not files selected', () => {
    const dir = join(baseTmp, 'count');
    seed(dir, {
      '2026-07-03T10-00-00+0200-a.md': extract('has sections'),
      // Selected by the filename window, but contributes no block.
      '2026-07-02T10-00-00+0200-b.md': '# no wanted sections\n\n## Observations\n- x\n',
      '2026-07-01T10-00-00+0200-c.md': extract('also has sections'),
    });

    const { context } = runHook({ sessionsDir: dir, count: 3 });

    assert.ok(context.includes('the 2 most recent session extracts'));
    assert.ok(!context.includes('the 3 most recent session extracts'));
  });

  it('does not end a section at a "## " line inside a fenced block', () => {
    const dir = join(baseTmp, 'fence');
    seed(dir, {
      '2026-07-03T10-00-00+0200-f.md': extract('fenced session', {
        context: 'before\n```\n## not a heading\n```\nafter',
      }),
    });

    const { context } = runHook({ sessionsDir: dir });

    // Content past the fence stays in Context instead of being cut off there.
    assert.ok(context.includes('after'));
    // And the real next section is still excluded.
    assert.ok(!context.includes('must NOT be injected'));
  });

  it('emits nothing when the extracts directory is absent', () => {
    const { stdout, status } = runHook({ sessionsDir: join(baseTmp, 'does-not-exist') });
    assert.equal(status, 0);
    assert.equal(stdout, '');
  });
});
