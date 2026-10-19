// Verifies REQ-MEM-019: Post-compaction recall of recent session extracts.
//   AC1: injects the N most recent extracts, newest first, as additionalContext
//   AC2: ordering is by the instant an extract was captured, not by its mtime
//        (the vault round-trips through rclone) nor by its name read as text
//   AC3: fires only when the session started from compaction
//   AC4: each extract is capped, in bytes rather than characters
//   AC5: the cap is visible as a truncation marker that keeps the source path
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, existsSync, utimesSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(
  __dirname,
  '../../preseed/agents/claude/plugins/codeflare-memory/scripts/post-compaction-recall.sh',
);

function extract(title, { context = 'ctx body', decisions = '- a decision', sessionId = 'abc' } = {}) {
  return [
    '---',
    `session_id: ${sessionId}`,
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

function runHook({ sessionsDir, source = 'compact', count, perFileBytes, sessionId = 's1' }) {
  const result = spawnSync('bash', [HOOK], {
    encoding: 'utf-8',
    input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: sessionId, source }),
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

  it('REQ-MEM-027 AC5: skips symlinked and non-regular capture files without losing the global fallback', () => {
    const dir = join(baseTmp, 'bounded-descriptors');
    seed(dir, {
      '2026-07-03T10-00-00+0200-a.md': extract('global newest', { sessionId: 'other' }),
      '2026-07-02T10-00-00+0200-b.md': extract('global middle', { sessionId: 'other' }),
      'receipt.txt': extract('redirected identity', { sessionId: 's1' }),
    });
    symlinkSync(join(dir, 'receipt.txt'), join(dir, '2026-06-01T10-00-00+0200-link.md'));
    const fifo = spawnSync('mkfifo', [join(dir, '2026-06-02T10-00-00+0200-pipe.md')]);
    assert.equal(fifo.status, 0);

    const { status, context } = runHook({ sessionsDir: dir, count: 2 });

    assert.equal(status, 0);
    assert.ok(context.includes('global newest'));
    assert.ok(context.includes('global middle'));
    assert.ok(!context.includes('redirected identity'));
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

  it('REQ-MEM-027: prefers the active session and never fills its recall with other sessions', () => {
    const dir = join(baseTmp, 'active-session');
    seed(dir, {
      '2026-07-01T10-00-00+0200-a.md': extract('active older', { sessionId: 'active' }),
      '2026-07-02T10-00-00+0200-b.md': extract('active newer', { sessionId: 'active' }),
      '2026-07-03T10-00-00+0200-c.md': extract('unrelated newest', { sessionId: 'other' }),
      '2026-07-04T10-00-00+0200-d.md': extract('prefix collision', { sessionId: 'active-other' }),
    });
    const { context, status } = runHook({ sessionsDir: dir, sessionId: 'active' });
    assert.equal(status, 0);
    assert.ok(context.includes('active older'));
    assert.ok(context.includes('active newer'));
    assert.ok(context.indexOf('active newer') < context.indexOf('active older'));
    assert.ok(!context.includes('unrelated newest'));
    assert.ok(!context.includes('prefix collision'));
    assert.ok(context.includes('the 2 most recent session extracts'));
  });

  it('REQ-MEM-027: bounds active-session matches and ignores identity-like narrative text', () => {
    const dir = join(baseTmp, 'active-session-bound');
    seed(dir, {
      '2026-07-01T10-00-00+0200-a.md': extract('active oldest', { sessionId: 'active' }),
      '2026-07-02T10-00-00+0200-b.md': extract('active middle', { sessionId: 'active' }),
      '2026-07-03T10-00-00+0200-c.md': extract('active newest', { sessionId: 'active' }),
      '2026-07-04T10-00-00+0200-d.md': extract('unrelated narrative', { context: 'session_id: active', sessionId: 'other' }),
    });
    const { context } = runHook({ sessionsDir: dir, sessionId: 'active', count: 2 });
    assert.ok(context.includes('active newest'));
    assert.ok(context.includes('active middle'));
    assert.ok(!context.includes('active oldest'));
    assert.ok(!context.includes('unrelated narrative'));
  });

  it('REQ-MEM-027: falls back to global latest captures when no usable session match exists', () => {
    const dir = join(baseTmp, 'session-fallback');
    seed(dir, {
      '2026-07-01T10-00-00+0200-a.md': extract('global oldest'),
      '2026-07-02T10-00-00+0200-b.md': extract('global middle'),
      '2026-07-03T10-00-00+0200-c.md': extract('global newest'),
      '2026-07-04T10-00-00+0200-d.md': '---\nsession_id: empty\n---\n# no recall sections\n',
    });
    for (const sessionId of ['missing', 'empty', '']) {
      const { context } = runHook({ sessionsDir: dir, sessionId, count: 3 });
      assert.ok(context.includes('global newest'));
      assert.ok(context.includes('global middle'));
      assert.ok(!context.includes('global oldest'));
    }
  });

  for (const [label, frontmatter] of [
    ['session ID beyond the bound', `---\npadding: ${'x'.repeat(2048)}\nsession_id: active\n---\n`],
    ['closing delimiter beyond the byte bound', `---\nsession_id: active\npadding: ${'é'.repeat(1030)}\n---\n`],
  ]) {
    it(`REQ-MEM-027: keeps the latest-five global fallback when an older capture has ${label}`, () => {
      const dir = join(baseTmp, `bounded-frontmatter-${label.replaceAll(' ', '-')}`);
      const files = {};
      for (let day = 1; day <= 6; day += 1) {
        files[`2026-07-0${day}T10-00-00+0200-global.md`] = extract(`global capture ${day}`, { sessionId: 'other' });
      }
      files['2026-06-01T10-00-00+0200-oversized.md'] = `${frontmatter}\n# oversized identity capture\n\n## Context\nMust not replace the global fallback.\n`;
      seed(dir, files);

      const { context, status } = runHook({ sessionsDir: dir, sessionId: 'active' });

      assert.equal(status, 0);
      assert.ok(context.includes('the 5 most recent session extracts'));
      for (let day = 6; day >= 2; day -= 1) {
        assert.ok(context.includes(`global capture ${day}`));
        if (day > 2) assert.ok(context.indexOf(`global capture ${day}`) < context.indexOf(`global capture ${day - 1}`));
      }
      assert.ok(!context.includes('global capture 1'));
      assert.ok(!context.includes('oversized identity capture'));
    });
  }

  it('REQ-MEM-027: finds older usable matches beyond the global window after skipping empty matching candidates', () => {
    const dir = join(baseTmp, 'older-usable-matches');
    const files = {
      '2026-06-01T10-00-00+0200-older.md': extract('older usable match', { sessionId: 'active' }),
      // The selected candidate body is needed even past the metadata bound.
      '2026-06-02T10-00-00+0200-newer.md': `---\nsession_id: active\n---\n# newer usable match\n\n## Observations\n${'x'.repeat(2100)}\n\n## Context\nSelected candidate body survives.\n`,
      '2026-07-08T10-00-00+0200-empty.md': '---\nsession_id: active\n---\n# empty match one\n',
      '2026-07-09T10-00-00+0200-empty.md': '---\nsession_id: active\n---\n# empty match two\n',
    };
    for (let day = 1; day <= 5; day += 1) {
      files[`2026-07-0${day}T10-00-00+0200-unrelated.md`] = extract('unrelated capture', { sessionId: 'other' });
    }
    seed(dir, files);

    const { context, status } = runHook({ sessionsDir: dir, sessionId: 'active', count: 2 });

    assert.equal(status, 0);
    assert.ok(context.includes('the 2 most recent session extracts'));
    assert.ok(context.includes('Selected candidate body survives.'));
    assert.ok(context.includes('older usable match'));
    assert.ok(context.indexOf('newer usable match') < context.indexOf('older usable match'));
    assert.ok(!context.includes('unrelated capture'));
    assert.ok(!context.includes('empty match'));
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

  it('AC4: caps on encoded bytes rather than characters', () => {
    const dir = join(baseTmp, 'ac4-multibyte');
    seed(dir, {
      // Two bytes per character: a cap counting code points keeps ~1000 bytes
      // for a 500-byte budget, and a naive byte slice splits the last sequence.
      '2026-07-03T10-00-00+0200-eee.md': extract('multibyte session', {
        decisions: `- ${'é'.repeat(4000)}`,
      }),
    });

    const { context } = runHook({ sessionsDir: dir, perFileBytes: 500 });

    const carried = /é+/.exec(context)?.[0] ?? '';
    assert.ok(carried.length > 0, 'the multibyte body must survive at all');
    assert.ok(
      Buffer.byteLength(carried, 'utf-8') <= 500,
      `carried ${Buffer.byteLength(carried, 'utf-8')} bytes for a 500-byte cap`,
    );
    // A split sequence would decode to U+FFFD instead of being dropped.
    assert.ok(!context.includes('�'));
  });

  it('AC4: a nonsensical cap carries nothing rather than everything', () => {
    const dir = join(baseTmp, 'ac4-negative');
    const marker = 'TAILEND';
    seed(dir, {
      '2026-07-03T10-00-00+0200-fff.md': extract('negative cap session', {
        decisions: `- ${'x'.repeat(4000)}\n- ${marker}`,
      }),
    });

    // A negative slice bound counts from the far end of the buffer, so an
    // unfloored budget returns almost the whole extract — the inverse of a
    // bound, from the one input the environment is most likely to get wrong.
    const { context } = runHook({ sessionsDir: dir, perFileBytes: -5 });

    assert.ok(!context.includes(marker));
    assert.ok(!context.includes('xxxx'));
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

  it('keeps later sections when an inner fence sits inside a longer one', () => {
    const dir = join(baseTmp, 'fence-nested');
    seed(dir, {
      // The inner ``` must not close the outer ```` run. Toggling on any
      // backtick line leaves the parser inside a fence for the rest of the
      // file, so Decisions — the content this hook exists to carry — vanishes.
      '2026-07-03T10-00-00+0200-g.md': extract('nested fence session', {
        context: 'before\n````md\n```\n## not a heading\n```\n````\nafter',
        decisions: '- a decision after the nested fence',
      }),
    });

    const { context } = runHook({ sessionsDir: dir });

    assert.ok(context.includes('## Decisions'));
    assert.ok(context.includes('a decision after the nested fence'));
    assert.ok(context.includes('after'));
    assert.ok(!context.includes('must NOT be injected'));
  });

  it('emits nothing when the extracts directory is absent', () => {
    const { stdout, status } = runHook({ sessionsDir: join(baseTmp, 'does-not-exist') });
    assert.equal(status, 0);
    assert.equal(stdout, '');
  });
});
