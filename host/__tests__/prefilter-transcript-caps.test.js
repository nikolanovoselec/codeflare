// The capture prefilter bounds what one capture run can cost. Without a
// ceiling the slice grows with session length: a resumed session produced 50
// chunks and cost 220k tokens to summarise, because the contract reads every
// chunk in order. These caps mirror Pi's MEMORY_CAPTURE_MAX_TURNS and
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

function runPrefilter(turns) {
  const dir = mkdtempSync(join(tmpdir(), 'prefilter-caps-'));
  const transcript = join(dir, 't.jsonl');
  writeFileSync(transcript, turns.map((text, i) => JSON.stringify({
    type: 'user',
    message: { content: `turn-${i} ${text}` },
    timestamp: '2026-07-26T00:00:00Z',
  })).join('\n') + '\n');
  const out = join(dir, 'out');
  const res = spawnSync('bash', [SCRIPT, transcript, '1', String(turns.length + 1), out, '20'], { encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const rows = readFileSync(join(out, 'clean.ndjson'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));
  return { rows, out };
}

describe('prefilter-transcript.sh payload ceilings', () => {
  it('keeps only the most recent turns when the window is long', () => {
    const { rows } = runPrefilter(Array.from({ length: 120 }, () => 'body'));
    assert.equal(rows.length, 40);
    // Recency is the load-bearing half: the newest turn is the one the user
    // just sent, and dropping it would capture a conversation without its point.
    assert.match(rows.at(-1).text, /^turn-119 /);
    assert.match(rows[0].text, /^turn-80 /);
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
      assert.match(rows[0].text, new RegExp(citation.replace('#', '#')),
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
