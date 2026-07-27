import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

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

function extract(title: string, options: { context?: string; decisions?: string } = {}): string {
  const { context = 'ctx body', decisions = '- a decision' } = options;
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
