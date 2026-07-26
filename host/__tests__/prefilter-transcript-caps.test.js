// The capture prefilter bounds what one capture run can cost. Without a
// ceiling the slice grows with session length: a resumed session produced 50
// chunks and cost 220k tokens to summarise, because the contract reads every
// chunk in order. These caps mirror Pi's MEMORY_CAPTURE_MAX_TOTAL_CHARS and
// MEMORY_CAPTURE_MAX_TURN_CHARS, so both runtimes hand their capture agent a
// payload with the same fixed worst case.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../preseed/agents/claude/plugins/codeflare-memory/scripts/prefilter-transcript.sh',
);

const BUDGET = 200000;

// A turn is either a string (a user prompt) or {role, text}.
function record(turn, i) {
  const { role, text } = typeof turn === 'string' ? { role: 'user', text: turn } : turn;
  const body = `turn-${i} ${text}`;
  return JSON.stringify(role === 'user'
    ? { type: 'user', message: { content: body }, timestamp: '2026-07-26T00:00:00Z' }
    : { type: 'assistant', message: { content: [{ type: 'text', text: body }] }, timestamp: '2026-07-26T00:00:00Z' });
}

function runPrefilter(turns) {
  const dir = mkdtempSync(join(tmpdir(), 'prefilter-caps-'));
  const transcript = join(dir, 't.jsonl');
  writeFileSync(transcript, turns.map(record).join('\n') + '\n');
  const out = join(dir, 'out');
  const res = spawnSync('bash', [SCRIPT, transcript, '1', String(turns.length + 1), out, '20'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const rows = readFileSync(join(out, 'clean.ndjson'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { rows, out };
}

describe('prefilter-transcript.sh payload ceilings', () => {
  it('spends the character budget newest-first when the window is long', () => {
    const { rows } = runPrefilter(Array.from({ length: 120 }, () => 'x'.repeat(5000)));
    const total = rows.reduce((sum, row) => sum + row.text.length, 0);
    // Both directions: the budget is a ceiling, and it is actually filled. A
    // selection that kept one turn would pass the first assertion alone.
    assert.ok(total <= BUDGET, `payload must fit the budget, got ${total}`);
    assert.ok(total > BUDGET - 6000, `budget must be spent, only used ${total}`);
    // Recency is the load-bearing half: the newest turn is the one the user
    // just sent, and dropping it would capture a conversation without its point.
    assert.match(rows.at(-1).text, /^turn-119 /);
    assert.match(rows[0].text, /^turn-\d+ /);
    assert.ok(!rows.some((row) => row.text.startsWith('turn-0 ')), 'the oldest turn is past the budget');
  });

  it('keeps every user prompt in a window whose assistant turns exhaust the budget', () => {
    // The capture fires on a count of user prompts, so a payload that drops
    // them summarises a window without the instructions that defined it. The
    // assistant turns here alone cost twice the budget.
    const { rows } = runPrefilter(Array.from({ length: 80 }, (_, i) => (i % 2 === 0
      ? { role: 'user', text: 'ask' }
      : { role: 'assistant', text: 'x'.repeat(25000) })));

    const labels = (role) => rows.filter((row) => row.role === role).map((row) => row.text.split(' ')[0]);
    assert.deepEqual(
      labels('user'),
      Array.from({ length: 40 }, (_, i) => `turn-${i * 2}`),
      'every user prompt survives, in order',
    );

    const assistants = labels('assistant');
    assert.ok(assistants.length > 0 && assistants.length < 40, `assistant turns are trimmed, kept ${assistants.length}`);
    assert.equal(assistants.at(-1), 'turn-79', 'the newest assistant turn is kept');
    assert.ok(!assistants.includes('turn-1'), 'the oldest assistant turn is dropped');
    assert.ok(rows.reduce((sum, row) => sum + row.text.length, 0) <= BUDGET);
  });

  it('truncates an oversized turn instead of passing it through', () => {
    const { rows } = runPrefilter(['short', 'x'.repeat(24000), 'short']);
    assert.equal(rows.length, 3);
    assert.equal(Math.max(...rows.map((r) => r.text.length)), 10000);
  });

  it('rescues citations that the truncation cut off', () => {
    // The cap is allowed to cost prose. It is not allowed to cost a REQ id,
    // an ADR, a PR number or a SHA -- those are what AD58 requires be verbatim
    // and what a later graph query searches on.
    const tail = 'closed REQ-AGENT-040 AC5 per AD58 in 4899fb6 and PR #709';
    const { rows } = runPrefilter(['pre '.repeat(4000) + tail]);
    for (const citation of ['REQ-AGENT-040', 'AD58', '4899fb6', '#709']) {
      assert.ok(rows[0].text.includes(citation),
        `${citation} sat past the cap and must survive it`);
    }
    assert.ok(rows[0].text.length > 10000, 'the rescue line is appended after the cap');
  });

  it('leaves a normal window untouched', () => {
    // A 15-prompt window is ~30-40 turns, so the ceiling must not bite there;
    // a cap that fires in the common case would silently lose ordinary history.
    const { rows } = runPrefilter(Array.from({ length: 30 }, () => 'body'));
    assert.equal(rows.length, 30);
    assert.match(rows[0].text, /^turn-0 /);
    // An uncut turn must be byte-identical to an uncapped run: no marker, no
    // rescue line, nothing appended.
    assert.equal(rows[0].text, 'turn-0 body');
  });
});
