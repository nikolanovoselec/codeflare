// REQ-MEM-001 backfill: covers the AC3 / AC4 / AC5 gaps left by
// memory-capture-hook.test.js (which covers the hook entry path:
// transcript counting, counter file semantics, additionalContext
// emission). This file exercises the post-hook pipeline:
//
//   AC3 - prefilter-transcript.sh strips tool I/O and chunks the
//         remainder into ~20-entry files.
//   AC4 - the memory-agent prompt declares the YAML frontmatter
//         template (session_id, captured_at, captured_from_range).
//   AC5 - the prompt runs graphify extract + global add under
//         flock /tmp/graphify-global.lock.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PREFILTER = resolve(
  __dirname,
  '../../preseed/agents/claude/plugins/codeflare-memory/scripts/prefilter-transcript.sh',
);
const PROMPT = resolve(
  __dirname,
  '../../preseed/agents/claude/plugins/codeflare-memory/scripts/memory-agent-prompt.md',
);

function realUserLine(content) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content } });
}
function assistantTextLine(text) {
  return JSON.stringify({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  });
}
function toolResultLine() {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', content: 'x' }] },
  });
}
function toolUseLine() {
  return JSON.stringify({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', name: 'Read', input: { file_path: '/x' } }],
    },
  });
}
function syntheticUserLine(prefix) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: prefix + ' continued' } });
}
function metaLine() {
  // isMeta records are agent-internal control records - prefilter must skip
  return JSON.stringify({ type: 'user', isMeta: true, message: { role: 'user', content: 'meta' } });
}

describe('prefilter-transcript.sh (REQ-MEM-001 AC3)', () => {
  it('AC3: strips tool_use, tool_result, and synthetic markers; keeps real prompts + assistant text', () => {
    const out = mkdtempSync(join(tmpdir(), 'prefilter-strip-'));
    const transcript = join(out, 'transcript.jsonl');
    writeFileSync(
      transcript,
      [
        realUserLine('first real prompt'),
        toolResultLine(),
        toolUseLine(),
        assistantTextLine('assistant reply one'),
        syntheticUserLine('<command-name>'),
        syntheticUserLine('Stop hook executed'),
        syntheticUserLine('This session is being continued'),
        syntheticUserLine('[Request interrupted by user]'),
        metaLine(),
        realUserLine('second real prompt'),
        assistantTextLine('assistant reply two'),
      ].join('\n') + '\n',
    );

    const result = spawnSync('bash', [PREFILTER, transcript, '1', '999', out, '20'], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `prefilter exit code: ${result.status}, stderr: ${result.stderr}`);

    const clean = readFileSync(join(out, 'clean.ndjson'), 'utf8').trim().split('\n').filter(Boolean);
    // Expect 4 surviving entries: 2 user prompts + 2 assistant replies.
    assert.equal(clean.length, 4, `prefilter kept ${clean.length} entries, expected 4`);

    const parsed = clean.map((line) => JSON.parse(line));
    const userTexts = parsed.filter((p) => p.role === 'user').map((p) => p.text);
    const assistantTexts = parsed.filter((p) => p.role === 'assistant').map((p) => p.text);

    assert.deepEqual(userTexts.sort(), ['first real prompt', 'second real prompt']);
    assert.deepEqual(assistantTexts.sort(), ['assistant reply one', 'assistant reply two']);
  });

  it('AC3: produces multiple chunks when input exceeds chunk size', () => {
    const out = mkdtempSync(join(tmpdir(), 'prefilter-chunk-'));
    const transcript = join(out, 'transcript.jsonl');
    // 50 real entries -> at chunk size 20 -> 3 chunks (aa: 20, ab: 20, ac: 10)
    const lines = [];
    for (let i = 0; i < 25; i++) {
      lines.push(realUserLine(`prompt ${i}`));
      lines.push(assistantTextLine(`reply ${i}`));
    }
    writeFileSync(transcript, lines.join('\n') + '\n');

    const result = spawnSync('bash', [PREFILTER, transcript, '1', '999', out, '20'], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `prefilter exit code: ${result.status}, stderr: ${result.stderr}`);

    const chunkMd = readdirSync(out).filter((f) => f.startsWith('chunk-') && f.endsWith('.md'));
    assert.ok(
      chunkMd.length >= 2,
      `expected >=2 .md chunks for 50 entries at chunk_size 20, got ${chunkMd.length}: ${chunkMd.join(',')}`,
    );
    // Default 20-per-chunk should produce 3 markdown files.
    assert.equal(chunkMd.length, 3, `expected exactly 3 chunks (20+20+10), got ${chunkMd.length}`);
  });

  it('AC3: significantly reduces byte count vs raw transcript', () => {
    // The whole point of the prefilter (per AD58) is that the raw
    // transcript is ~99% tool noise. Verify the strip ratio empirically:
    // a transcript dominated by tool I/O must shrink dramatically.
    const out = mkdtempSync(join(tmpdir(), 'prefilter-bytes-'));
    const transcript = join(out, 'transcript.jsonl');
    const lines = [];
    // 2 real entries vs 200 tool I/O entries = ~99% noise
    lines.push(realUserLine('keep me 1'));
    lines.push(assistantTextLine('keep this 1'));
    for (let i = 0; i < 200; i++) {
      lines.push(toolResultLine());
      lines.push(toolUseLine());
    }
    writeFileSync(transcript, lines.join('\n') + '\n');

    const result = spawnSync('bash', [PREFILTER, transcript, '1', '99999', out, '20'], {
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, `prefilter exit code: ${result.status}, stderr: ${result.stderr}`);

    const rawBytes = statSync(transcript).size;
    const cleanBytes = statSync(join(out, 'clean.ndjson')).size;
    const ratio = rawBytes / cleanBytes;
    // Demand at least 10x reduction (in practice AD58 measured ~76x).
    assert.ok(
      ratio >= 10,
      `prefilter reduction ratio ${ratio.toFixed(1)}x is below the 10x floor (raw=${rawBytes} clean=${cleanBytes})`,
    );
  });
});

describe('memory-agent-prompt.md frontmatter + flock (REQ-MEM-001 AC4 + AC5)', () => {
  const prompt = readFileSync(PROMPT, 'utf8');

  it('AC4: declares the YAML frontmatter template with session_id, captured_at, captured_from_range', () => {
    // The template is a fenced code block in the prompt. The fields
    // must be present together so the produced capture files are
    // queryable by graphify and round-trippable.
    assert.ok(/session_id:\s*\{SESSION_ID\}/.test(prompt),
      'memory-agent-prompt.md must declare session_id: {SESSION_ID} in the frontmatter template');
    assert.ok(/captured_at:\s*\{ISO_TS\}/.test(prompt),
      'memory-agent-prompt.md must declare captured_at: {ISO_TS} in the frontmatter template');
    assert.ok(/captured_from_range:\s*\[\{LAST_LINE\},\s*\{TOTAL_LINES\}\]/.test(prompt),
      'memory-agent-prompt.md must declare captured_from_range: [{LAST_LINE}, {TOTAL_LINES}] in the frontmatter template');
  });

  it('AC4: frontmatter is delimited by triple-dash lines', () => {
    // YAML frontmatter requires `---` open/close fences. Missing them
    // and the SilverBullet front-matter parser will silently treat the
    // block as body text.
    const openFenceCount = (prompt.match(/^---$/gm) || []).length;
    assert.ok(
      openFenceCount >= 2,
      `memory-agent-prompt.md must include the YAML frontmatter --- open + close fences (found ${openFenceCount})`,
    );
  });

  it('AC5: graphify extract and global add run under flock /tmp/graphify-global.lock', () => {
    // The capture pipeline shares the global graph lock with the
    // vault-monitor pipeline and the active-repo hook. Without flock,
    // concurrent writers would corrupt the JSON-on-disk merge.
    assert.ok(
      /flock\s+\/tmp\/graphify-global\.lock\s+.*graphify\s+global\s+add/.test(prompt) ||
        /flock\s+\/tmp\/graphify-global\.lock[\s\S]*?graphify\s+global\s+add/.test(prompt),
      'memory-agent-prompt.md must call `graphify global add` under flock /tmp/graphify-global.lock',
    );
    // The build step (extract -> graph.json) should be lock-protected
    // too because it writes to the shared vault graphify-out tree.
    assert.ok(
      /flock\s+\/tmp\/graphify-global\.lock/.test(prompt),
      'memory-agent-prompt.md must serialize graphify writes behind flock /tmp/graphify-global.lock',
    );
  });

  it('AC5: tags the merged repo as user_vault so subsequent queries can filter by tag', () => {
    assert.ok(
      /graphify\s+global\s+add\s+\S+\s+--as\s+user_vault/.test(prompt),
      'memory-agent-prompt.md must pass --as user_vault to `graphify global add` for repo-tag filtering',
    );
  });
});
