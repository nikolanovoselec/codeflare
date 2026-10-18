import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { captureFilename } from '../../../preseed/agents/pi/extensions/memory-vault-helpers';
import {
  capBytes,
  captureInstant,
  orderByCaptureInstant,
  recallBlock,
  sections,
} from '../../../preseed/agents/pi/extensions/post-compaction-recall-helpers';
import {
  buildRecall,
  POST_COMPACTION_RECALL_TYPE,
  registerPostCompactionRecall,
  type PostCompactionRecallPi,
} from '../../../preseed/agents/pi/extensions/post-compaction-recall';

const roots: string[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function extractsDir(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'pi-post-compact-'));
  roots.push(root);
  const dir = join(root, 'Sessions');
  mkdirSync(dir, { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}

function extract(title: string, options: { context?: string; decisions?: string; sessionId?: string } = {}): string {
  const { context = 'ctx body', decisions = '- a decision', sessionId = 'abc' } = options;
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

interface SentMessage {
  message: { customType: string; content: string; display: boolean; details?: unknown };
  options: { deliverAs: string; triggerTurn: boolean };
}

function fakePi(): {
  pi: PostCompactionRecallPi;
  fire(event: string, ctx?: unknown): void;
  sent: SentMessage[];
} {
  const handlers = new Map<string, (event: any, ctx: any) => void>();
  const sent: SentMessage[] = [];
  const pi: PostCompactionRecallPi = {
    on(event, handler) {
      handlers.set(event, handler as (event: any, ctx: any) => void);
    },
    sendMessage(message, options) {
      sent.push({ message, options });
    },
  };
  return {
    pi,
    fire(event, ctx = {}) {
      handlers.get(event)?.({ type: event }, ctx);
    },
    sent,
  };
}

describe('Pi post-compaction recall (REQ-MEM-019)', () => {
  it('AC2: orders by the captured instant, not by the name read as text', () => {
    // 02:30+0100 is 01:30Z, the LATER instant, but the lower name as text.
    const later = '2026-10-25T02-30-00+0100-a.md';
    const earlier = '2026-10-25T02-45-00+0200-b.md';

    expect(captureInstant(later)).toBeGreaterThan(captureInstant(earlier)!);
    expect(orderByCaptureInstant([earlier, later])).toEqual([later, earlier]);
  });

  it('AC2: breaks a shared instant on the name, descending', () => {
    // Same wall clock, same offset: only the tie-break decides, and it must
    // decide the same way the shell runtime does.
    const first = '2026-07-01T10-00-00+0200-aaa.md';
    const second = '2026-07-01T10-00-00+0200-bbb.md';

    expect(captureInstant(first)).toBe(captureInstant(second));
    expect(orderByCaptureInstant([first, second])).toEqual([second, first]);
    expect(orderByCaptureInstant([second, first])).toEqual([second, first]);
  });

  it('AC2: sorts names carrying no parseable instant last', () => {
    const dated = '2026-07-01T10-00-00+0200-a.md';

    expect(orderByCaptureInstant(['notes.md', dated])).toEqual([dated, 'notes.md']);
    expect(captureInstant('2026-13-40T99-99-99+0200-x.md')).toBeNull();
  });

  it('AC1: carries Context and Decisions, and never Observations', () => {
    const block = recallBlock('/vault/a.md', extract('a session'), 2600);

    expect(block).toContain('## Context');
    expect(block).toContain('## Decisions');
    expect(block).not.toContain('must NOT be injected');
    // The path is what makes the omitted sections recoverable.
    expect(block).toContain('Source: /vault/a.md');
  });

  it('AC1: skips an extract carrying none of the wanted sections', () => {
    expect(recallBlock('/vault/b.md', '# only observations\n\n## Observations\n- x\n', 2600)).toBeNull();
  });

  it('keeps later sections when an inner fence sits inside a longer one', () => {
    const found = sections(
      ['## Context', 'before', '````md', '```', '## not a heading', '```', '````', 'after', '', '## Decisions', '- kept'].join('\n'),
    );

    expect([...found.keys()]).toEqual(['## Context', '## Decisions']);
    expect(found.get('## Context')).toContain('after');
    expect(found.get('## Decisions')).toBe('- kept');
  });

  it('AC4: caps on encoded bytes rather than UTF-16 units', () => {
    const capped = capBytes('é'.repeat(4000), 500);

    const carried = /é+/.exec(capped)?.[0] ?? '';
    expect(carried.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(carried, 'utf-8')).toBeLessThanOrEqual(500);
    // A sequence the slice cut in half would decode to U+FFFD.
    expect(capped).not.toContain(String.fromCharCode(0xfffd));
  });

  it('AC5: marks the truncation, spending the marker from the same budget', () => {
    expect(capBytes('short', 500)).toBe('short');

    const capped = capBytes('x'.repeat(600), 500);

    expect(capped).toContain('truncated');
    // The marker is part of the bound, not an addition to it: appending it
    // after a full-budget slice would put every capped block over its cap.
    expect(Buffer.byteLength(capped, 'utf-8')).toBeLessThanOrEqual(500);
  });

  it('AC4: holds the bound even when the cap cannot fit the marker', () => {
    // perFileBytes is caller-supplied, so a cap below the marker length is
    // reachable. The bound is the guarantee; the notice is what gives way.
    const tiny = capBytes('x'.repeat(600), 10);

    expect(Buffer.byteLength(tiny, 'utf-8')).toBeLessThanOrEqual(10);
    expect(tiny).not.toBe('');
  });

  it('AC4: a nonsensical cap carries nothing rather than everything', () => {
    // A negative slice bound counts from the far end, so an unfloored budget
    // returns almost the whole text — the inverse of a bound, from the one
    // input a caller is most likely to get wrong.
    expect(capBytes('x'.repeat(600), -5)).toBe('');
    expect(capBytes('x'.repeat(600), 0)).toBe('');
  });

  it('AC6: selects a filename produced by Pi capture alongside Claude extracts', () => {
    const piFilename = captureFilename('019fa5d1-04cc-7b7f-8fd7-b58a8c4dda6c', 'UTC');
    const dir = extractsDir({
      [piFilename]: extract('Pi capture'),
      '2000-01-01T00-00-00+0000-claude.md': extract('old Claude capture'),
    });

    const content = buildRecall({ sessionsDir: dir, extractCount: 1, perFileBytes: 2600 })!;

    expect(content).toContain('Pi capture');
    expect(content).not.toContain('old Claude capture');
  });

  it('AC1: builds the digest newest-first, bounded by the extract count', () => {
    const dir = extractsDir({
      '2026-07-01T10-00-00+0200-a.md': extract('oldest session'),
      '2026-07-02T10-00-00+0200-b.md': extract('middle session'),
      '2026-07-03T10-00-00+0200-c.md': extract('newest session'),
    });
    // rclone bisync rewrites mtimes, so make the oldest name the newest file.
    const future = new Date(Date.now() + 60_000);
    utimesSync(join(dir, '2026-07-01T10-00-00+0200-a.md'), future, future);

    const content = buildRecall({ sessionsDir: dir, extractCount: 2, perFileBytes: 2600 })!;

    expect(content).toContain('newest session');
    expect(content).toContain('middle session');
    expect(content).not.toContain('oldest session');
    expect(content.indexOf('newest session')).toBeLessThan(content.indexOf('middle session'));
  });

  it('counts blocks actually built, not files selected', () => {
    const dir = extractsDir({
      '2026-07-03T10-00-00+0200-a.md': extract('has sections'),
      '2026-07-02T10-00-00+0200-b.md': '# no wanted sections\n\n## Observations\n- x\n',
      '2026-07-01T10-00-00+0200-c.md': extract('also has sections'),
    });

    const content = buildRecall({ sessionsDir: dir, extractCount: 3, perFileBytes: 2600 })!;

    expect(content).toContain('the 2 most recent session extracts');
  });

  it('yields nothing when the extracts directory is absent', () => {
    expect(buildRecall({ sessionsDir: '/nope/does-not-exist', extractCount: 5, perFileBytes: 2600 })).toBeNull();
  });

  it('delivers the recall on compaction as a persisted follow-up', () => {
    const dir = extractsDir({ '2026-07-03T10-00-00+0200-a.md': extract('a session') });
    const { pi, fire, sent } = fakePi();
    registerPostCompactionRecall(pi, { sessionsDir: dir, extractCount: 5, perFileBytes: 2600 });

    fire('session_compact');

    expect(sent).toHaveLength(1);
    expect(sent[0].message.customType).toBe(POST_COMPACTION_RECALL_TYPE);
    expect(sent[0].message.content).toContain('a session');
    expect(sent[0].message.display).toBe(false);
    expect(sent[0].options).toEqual({ deliverAs: 'followUp', triggerTurn: false });
  });

  it('REQ-MEM-027: prefers exact active-session captures over newer unrelated captures without topping up', () => {
    const dir = extractsDir({
      '2026-07-01T10-00-00+0200-one.md': extract('active older', { sessionId: 'active-session' }),
      '2026-07-02T10-00-00+0200-two.md': extract('active newer', { sessionId: 'active-session' }),
      '2026-07-03T10-00-00+0200-three.md': extract('different session', { sessionId: 'other' }),
      '2026-07-04T10-00-00+0200-four.md': extract('prefix collision', { sessionId: 'active-session-longer' }),
    });
    const { pi, fire, sent } = fakePi();
    registerPostCompactionRecall(pi, { sessionsDir: dir, extractCount: 5, perFileBytes: 2600 });
    fire('session_compact', { sessionManager: { getSessionId: () => 'active-session' } });
    const content = sent[0]?.message.content ?? '';
    expect(content).toContain('active older');
    expect(content).toContain('active newer');
    expect(content.indexOf('active newer')).toBeLessThan(content.indexOf('active older'));
    expect(content).not.toContain('different session');
    expect(content).not.toContain('prefix collision');
    expect(content).toContain('the 2 most recent session extracts');
  });

  it('REQ-MEM-027: bounds matching captures before rendering and ignores session IDs in narrative text', () => {
    const dir = extractsDir({
      '2026-07-01T10-00-00+0200-a.md': extract('active oldest', { sessionId: 'active' }),
      '2026-07-02T10-00-00+0200-b.md': extract('active middle', { sessionId: 'active' }),
      '2026-07-03T10-00-00+0200-c.md': extract('active newest', { sessionId: 'active' }),
      '2026-07-04T10-00-00+0200-d.md': extract('unrelated narrative', { sessionId: 'other', context: 'session_id: active\nnot identity metadata' }),
    });
    const { pi, fire, sent } = fakePi();
    registerPostCompactionRecall(pi, { sessionsDir: dir, extractCount: 2, perFileBytes: 2600 });
    fire('session_compact', { sessionManager: { getSessionId: () => 'active' } });
    const content = sent[0]?.message.content ?? '';
    expect(content).toContain('active newest');
    expect(content).toContain('active middle');
    expect(content).not.toContain('active oldest');
    expect(content).not.toContain('unrelated narrative');
  });

  it('REQ-MEM-027: falls back to the latest global captures when no active-session capture exists', () => {
    const dir = extractsDir({
      '2026-07-01T10-00-00+0200-a.md': extract('global oldest'),
      '2026-07-02T10-00-00+0200-b.md': extract('global middle'),
      '2026-07-03T10-00-00+0200-c.md': extract('global newest'),
    });
    const { pi, fire, sent } = fakePi();
    registerPostCompactionRecall(pi, { sessionsDir: dir, extractCount: 2, perFileBytes: 2600 });
    fire('session_compact', { sessionManager: { getSessionId: () => 'missing-session' } });
    const content = sent[0]?.message.content ?? '';
    expect(content).toContain('global newest');
    expect(content).toContain('global middle');
    expect(content).not.toContain('global oldest');
  });

  it.each([
    ['session ID beyond the bound', `---\npadding: ${'x'.repeat(2048)}\nsession_id: active\n---\n`],
    ['closing delimiter beyond the byte bound', `---\nsession_id: active\npadding: ${'é'.repeat(1030)}\n---\n`],
  ])('REQ-MEM-027: keeps the latest-five global fallback when an older capture has %s', (_label, frontmatter) => {
    const files: Record<string, string> = {};
    for (let day = 1; day <= 6; day += 1) {
      files[`2026-07-0${day}T10-00-00+0200-global.md`] = extract(`global capture ${day}`, { sessionId: 'other' });
    }
    files['2026-06-01T10-00-00+0200-oversized.md'] = `${frontmatter}\n# oversized identity capture\n\n## Context\nMust not replace the global fallback.\n`;
    const dir = extractsDir(files);
    const { pi, fire, sent } = fakePi();
    registerPostCompactionRecall(pi, { sessionsDir: dir, extractCount: 5, perFileBytes: 2600 });

    fire('session_compact', { sessionManager: { getSessionId: () => 'active' } });

    const content = sent[0]?.message.content ?? '';
    expect(content).toContain('the 5 most recent session extracts');
    for (let day = 6; day >= 2; day -= 1) {
      expect(content).toContain(`global capture ${day}`);
      if (day > 2) expect(content.indexOf(`global capture ${day}`)).toBeLessThan(content.indexOf(`global capture ${day - 1}`));
    }
    expect(content).not.toContain('global capture 1');
    expect(content).not.toContain('oversized identity capture');
  });

  it('REQ-MEM-027: finds older usable matches beyond the global window after skipping empty matching candidates', () => {
    const files: Record<string, string> = {
      '2026-06-01T10-00-00+0200-older.md': extract('older usable match', { sessionId: 'active' }),
      // Metadata lookup is bounded, but a selected candidate still needs its
      // body: the wanted section deliberately starts beyond the metadata limit.
      '2026-06-02T10-00-00+0200-newer.md': `---\nsession_id: active\n---\n# newer usable match\n\n## Observations\n${'x'.repeat(2100)}\n\n## Context\nSelected candidate body survives.\n`,
      '2026-07-08T10-00-00+0200-empty.md': '---\nsession_id: active\n---\n# empty match one\n',
      '2026-07-09T10-00-00+0200-empty.md': '---\nsession_id: active\n---\n# empty match two\n',
    };
    for (let day = 1; day <= 5; day += 1) {
      files[`2026-07-0${day}T10-00-00+0200-unrelated.md`] = extract('unrelated capture', { sessionId: 'other' });
    }
    const dir = extractsDir(files);
    const { pi, fire, sent } = fakePi();
    registerPostCompactionRecall(pi, { sessionsDir: dir, extractCount: 2, perFileBytes: 2600 });

    fire('session_compact', { sessionManager: { getSessionId: () => 'active' } });

    const content = sent[0]?.message.content ?? '';
    expect(content).toContain('the 2 most recent session extracts');
    expect(content).toContain('Selected candidate body survives.');
    expect(content).toContain('older usable match');
    expect(content.indexOf('newer usable match')).toBeLessThan(content.indexOf('older usable match'));
    expect(content).not.toContain('unrelated capture');
    expect(content).not.toContain('empty match');
  });

  it('REQ-MEM-027 AC5: ignores symlinked capture identities and preserves the global fallback', () => {
    const dir = extractsDir({
      '2026-07-03T10-00-00+0200-a.md': extract('global newest', { sessionId: 'other' }),
      '2026-07-02T10-00-00+0200-b.md': extract('global middle', { sessionId: 'other' }),
      'receipt.txt': extract('redirected identity', { sessionId: 'active' }),
    });
    symlinkSync(join(dir, 'receipt.txt'), join(dir, '2026-07-01T10-00-00+0200-link.md'));

    const content = buildRecall({ sessionsDir: dir, extractCount: 2, perFileBytes: 2600 }, 'active') ?? '';

    expect(content).toContain('global newest');
    expect(content).toContain('global middle');
    expect(content).not.toContain('redirected identity');
  });

  it('REQ-MEM-027 AC6: retains the collected global fallback when the identity-search time budget expires', () => {
    const dir = extractsDir({
      '2026-07-03T10-00-00+0200-a.md': extract('global newest', { sessionId: 'other' }),
      '2026-07-02T10-00-00+0200-b.md': extract('global middle', { sessionId: 'other' }),
      '2026-07-01T10-00-00+0200-c.md': extract('older active match', { sessionId: 'active' }),
    });
    // Intentional lookup-deadline contract: fallback remains deliverable when
    // the six-second search budget expires, without waiting for wall-clock time.
    vi.spyOn(Date, 'now').mockReturnValueOnce(0).mockReturnValue(6001);

    const content = buildRecall({ sessionsDir: dir, extractCount: 2, perFileBytes: 2600 }, 'active') ?? '';

    expect(content).toContain('global newest');
    expect(content).toContain('global middle');
    expect(content).not.toContain('older active match');
  });

  it('REQ-MEM-027: fails open to global recall if session identity cannot be read', () => {
    const dir = extractsDir({ '2026-07-03T10-00-00+0200-a.md': extract('global fallback') });
    const { pi, fire, sent } = fakePi();
    registerPostCompactionRecall(pi, { sessionsDir: dir, extractCount: 5, perFileBytes: 2600 });
    fire('session_compact', { sessionManager: { getSessionId: () => { throw new Error('session unavailable'); } } });
    expect(sent[0]?.message.content).toContain('global fallback');
  });

  it('REQ-MEM-027: falls back when matching notes contain no usable recall sections', () => {
    const dir = extractsDir({
      '2026-07-01T10-00-00+0200-a.md': extract('usable fallback'),
      '2026-07-02T10-00-00+0200-b.md': '---\nsession_id: active\n---\n# empty capture\n',
    });
    const { pi, fire, sent } = fakePi();
    registerPostCompactionRecall(pi, { sessionsDir: dir, extractCount: 5, perFileBytes: 2600 });
    fire('session_compact', { sessionManager: { getSessionId: () => 'active' } });
    expect(sent[0]?.message.content).toContain('usable fallback');
  });

  it('stays out of a child session', () => {
    const dir = extractsDir({ '2026-07-03T10-00-00+0200-a.md': extract('a session') });
    const { pi, fire, sent } = fakePi();
    registerPostCompactionRecall(pi, { sessionsDir: dir, extractCount: 5, perFileBytes: 2600 });

    fire('session_compact', { sessionManager: { getHeader: () => ({ parentSession: 'parent-1' }) } });

    expect(sent).toHaveLength(0);
  });

  it('swallows a delivery failure instead of throwing into the compaction dispatch', () => {
    const dir = extractsDir({ '2026-07-03T10-00-00+0200-a.md': extract('a session') });
    const handlers = new Map<string, (event: any, ctx: any) => void>();
    let attempted = 0;
    const pi: PostCompactionRecallPi = {
      on(event, handler) {
        handlers.set(event, handler as (event: any, ctx: any) => void);
      },
      sendMessage() {
        attempted += 1;
        throw new Error('delivery refused');
      },
    };
    registerPostCompactionRecall(pi, { sessionsDir: dir, extractCount: 5, perFileBytes: 2600 });

    // This runs inside Pi's dispatch at the compaction boundary; a throw here
    // would surface in the session for a feature that is a convenience.
    expect(() => handlers.get('session_compact')!({ type: 'session_compact' }, {})).not.toThrow();
    expect(attempted).toBe(1);
  });

  it('sends nothing when no extract survives', () => {
    const dir = extractsDir({ '2026-07-03T10-00-00+0200-a.md': '# nothing wanted\n\n## Observations\n- x\n' });
    const { pi, fire, sent } = fakePi();
    registerPostCompactionRecall(pi, { sessionsDir: dir, extractCount: 5, perFileBytes: 2600 });

    fire('session_compact');

    expect(sent).toHaveLength(0);
  });
});
