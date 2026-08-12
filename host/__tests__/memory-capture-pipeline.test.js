// REQ-MEM-001 backfill: covers the AC3 / AC4 / AC5 gaps left by
// memory-capture-hook.test.js (which covers the hook entry path:
// transcript counting, counter file semantics, additionalContext
// emission). This file exercises the post-hook pipeline:
//
//   AC3 - prefilter-transcript.sh strips tool I/O and chunks the
//         remainder into ~20-entry files.
//   AC4 - the memory-agent prompt declares the YAML frontmatter
//         template (session_id, captured_at, captured_from_range).
//   AC6 - the executable publication helper retains retry state unless
//         cumulative merge and global publication both succeed.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PREFILTER = resolve(
  __dirname,
  '../../preseed/agents/claude/plugins/codeflare-memory/scripts/prefilter-transcript.sh',
);
const PUBLISH = resolve(
  __dirname,
  '../../preseed/agents/claude/plugins/codeflare-memory/scripts/publish-memory-capture.sh',
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

describe('prefilter-transcript.sh (REQ-MEM-001 AC3) / REQ-VAULT-002 (conversation captures land in vault as markdown)', () => {
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

describe('publish-memory-capture.sh (REQ-MEM-001 AC6)', () => {
  // The graphify stub APPENDS. With one invocation the log is byte-identical to
  // the single-line form these rows already assert; a second invocation (the viz
  // re-render) shows up as a second line instead of overwriting the first, which
  // is the only way to tell "render skipped" from "render clobbered the log".
  function fixture({ mergeStatus = 0, publishStatus = 0, carrierBody = '{}\n', withGraphifyOut = false, holdVizLock = false } = {}) {
    const root = mkdtempSync(join(tmpdir(), 'memory-publish-'));
    const carrier = join(root, 'capture.vars');
    const merge = join(root, 'merge');
    const graphify = join(root, 'graphify');
    const publicationLog = join(root, 'publication.log');
    const graphLock = join(root, 'graph.lock');
    writeFileSync(carrier, carrierBody);
    writeFileSync(merge, `#!/usr/bin/env bash\nexit ${mergeStatus}\n`);
    writeFileSync(graphify, `#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${publicationLog}'\nexit ${publishStatus}\n`);
    chmodSync(merge, 0o755);
    chmodSync(graphify, 0o755);
    // The production layout the derivation expects: <root>/graphify-out/<graph>.
    const vaultGraph = withGraphifyOut
      ? join(root, 'graphify-out', 'vault-graph.json')
      : join(root, 'vault-graph.json');
    if (withGraphifyOut) {
      mkdirSync(join(root, 'graphify-out'), { recursive: true });
      writeFileSync(join(root, 'graphify-out', 'graph.html'), '<html></html>');
    }
    // Hold the render lock the way a concurrent publisher would, and confirm it
    // is actually held rather than trusting a sleep.
    let holder;
    if (holdVizLock) {
      holder = spawn('bash', ['-c', `exec 9>"${graphLock}.viz"; flock 9; sleep 30`], {
        detached: true, stdio: 'ignore',
      });
      holder.unref();
      let held = false;
      for (let i = 0; i < 100 && !held; i++) {
        held = spawnSync('bash', ['-c', `exec 9>"${graphLock}.viz"; flock -n 9`]).status !== 0;
        if (!held) spawnSync('bash', ['-c', 'sleep 0.05']);
      }
      assert.ok(held, 'the concurrent publisher took the render lock');
    }
    const result = spawnSync('bash', [PUBLISH, carrier], {
      encoding: 'utf8',
      env: {
        ...process.env,
        MEMCAP_GRAPH_LOCK: graphLock,
        MEMCAP_PYTHON_BIN: merge,
        MEMCAP_MERGE_SCRIPT: join(root, 'merge-vault-graph.py'),
        MEMCAP_GRAPHIFY_BIN: graphify,
        MEMCAP_VAULT_GRAPH: vaultGraph,
      },
    });
    if (holder) { try { process.kill(-holder.pid, 'SIGKILL'); } catch { /* already gone */ } }
    return { root, carrier, publicationLog, result };
  }

  const graphifyCalls = (publicationLog) =>
    (existsSync(publicationLog) ? readFileSync(publicationLog, 'utf8') : '')
      .split('\n').filter(Boolean);

  it('retains the carrier and skips publication when the cumulative merge fails', () => {
    const { carrier, publicationLog, result } = fixture({ mergeStatus: 17 });
    assert.equal(result.status, 17);
    assert.ok(existsSync(carrier));
    assert.equal(existsSync(publicationLog), false);
  });

  it('retains the carrier when global publication fails', () => {
    const { carrier, publicationLog, result } = fixture({ publishStatus: 19 });
    assert.equal(result.status, 19);
    assert.ok(existsSync(publicationLog));
    assert.ok(existsSync(carrier));
  });

  it('removes the carrier only after merge and cumulative user_vault publication succeed', () => {
    const { carrier, publicationLog, result } = fixture();
    assert.equal(result.status, 0, result.stderr);
    assert.equal(existsSync(carrier), false);
    assert.match(readFileSync(publicationLog, 'utf8'), /^global add .*vault-graph\.json --as user_vault\n$/);
  });

  // The carrier is read to decide whether a capture file must exist. Reading it
  // with `jq -r … || true` made "field absent" and "carrier corrupt" the same
  // empty string, and empty skipped the existence check entirely -- so a corrupt
  // carrier published and advanced the counter with nothing captured.
  it('refuses to publish from a carrier it cannot parse', () => {
    const { carrier, publicationLog, result } = fixture({ carrierBody: 'not json{{{\n' });
    assert.equal(result.status, 3, result.stderr);
    assert.match(result.stderr, /carrier unreadable/);
    assert.ok(existsSync(carrier), 'an unparseable carrier is retained, not drained');
    assert.equal(graphifyCalls(publicationLog).length, 0, 'nothing is published from it');
  });

  // The render derives its root from MEMCAP_VAULT_GRAPH. A flat override has no
  // graphify-out beneath it, and rendering anyway put cluster-only into a
  // sibling directory and clobbered this very log.
  it('skips the viz re-render when the vault root has no graphify-out', () => {
    const { publicationLog, result } = fixture();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      graphifyCalls(publicationLog).map((line) => line.split(' ')[0]),
      ['global'],
      'the only graphify invocation is the global add',
    );
  });

  it('re-renders the viz when the vault root does carry a graphify-out', () => {
    const { root, publicationLog, result } = fixture({ withGraphifyOut: true });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      graphifyCalls(publicationLog).map((line) => line.split(' ')[0]),
      ['global', 'cluster-only'],
      'publication first, then the render it no longer holds the graph lock for',
    );
    assert.ok(existsSync(join(root, 'Raw', 'Graphs', 'vault-graph.html')),
      'the rendered HTML lands where the vault serves it from');
  });

  // Leaving the global lock gave the render its own concurrency problem: two
  // publishers clustering into one graphify-out and copying the same file over
  // each other. A second publisher skips instead of interleaving.
  it('skips the re-render rather than interleaving when another publisher holds it', () => {
    const { publicationLog, result } = fixture({ withGraphifyOut: true, holdVizLock: true });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(
      graphifyCalls(publicationLog).map((line) => line.split(' ')[0]),
      ['global'],
      'publication still happens; only the cosmetic render stands down',
    );
  });
});
