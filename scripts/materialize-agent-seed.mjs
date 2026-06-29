#!/usr/bin/env node
/**
 * REQ-STOR-017 / AD90 — materialize the generated agent seed into an on-disk file
 * tree so the container image can bake it (Governed Mode delta-sync lay-down).
 *
 * The seed (`AGENTS_SEEDED_CONFIGS` in src/lib/agent-seed.generated.ts) is the single
 * source of truth: `getConfigsForMode(mode, false)` is a PURE FILTER over it (no content
 * transform), and `seedDocuments` PUTs each doc's `content` verbatim to R2. So writing
 * the same filtered `content` to `<out>/<mode>/<key>` yields a tree byte-identical to what
 * a freshly-seeded R2 bucket holds — which is exactly what makes the `--checksum` initial
 * sync skip the unchanged seed files (it compares content hashes).
 *
 * `filterDocsForMode` mirrors `getConfigsForMode(mode, false)`; the drift guard is the
 * behavioral test src/__tests__/lib/agent-seed-bake.test.ts, which asserts this filter
 * produces the same (key, content) set as the TypeScript `getConfigsForMode`.
 *
 * Context-mode docs (the advanced+unlimited subset) are intentionally NOT baked — they
 * are tier-gated, so they delta-sync from R2 at runtime like any user content.
 *
 * Usage: node scripts/materialize-agent-seed.mjs [--seed <generated.ts>] [--out <dir>]
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CONTEXT_MODE_KEY_PREFIX = '.claude/plugins/context-mode/';
const PI_CONTEXT_MODE_EXTENSION_KEY = '.pi/agent/extensions/context-mode-enforcement.ts';

/**
 * Filter the generated seed to one session mode — the exact predicate of
 * getConfigsForMode(mode, false): in-mode, and excluding the tier-gated
 * context-mode subtree (both the Claude plugin tree and the Pi extension).
 */
export function filterDocsForMode(docs, mode) {
  return docs.filter(
    (doc) =>
      doc.modes.includes(mode) &&
      doc.key !== PI_CONTEXT_MODE_EXTENSION_KEY &&
      !doc.key.startsWith(CONTEXT_MODE_KEY_PREFIX)
  );
}

/** Parse AGENTS_SEEDED_CONFIGS (a JSON.stringify'd array) out of the generated TS module. */
export function parseGeneratedSeed(source) {
  const marker = source.indexOf('AGENTS_SEEDED_CONFIGS');
  if (marker === -1) throw new Error('materialize-agent-seed: AGENTS_SEEDED_CONFIGS not found in seed source');
  const start = source.indexOf('[', source.indexOf('=', marker));
  const end = source.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) {
    throw new Error('materialize-agent-seed: could not locate the AGENTS_SEEDED_CONFIGS array literal');
  }
  return JSON.parse(source.slice(start, end + 1));
}

async function main() {
  const args = process.argv.slice(2);
  const getArg = (flag, fallback) => {
    const i = args.indexOf(flag);
    return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
  };
  const here = path.dirname(fileURLToPath(import.meta.url));
  const seedPath = path.resolve(getArg('--seed', path.join(here, '..', 'src/lib/agent-seed.generated.ts')));
  const outDir = path.resolve(getArg('--out', path.join(here, '..', 'preseed/agent-seed-bake')));

  const docs = parseGeneratedSeed(await fs.readFile(seedPath, 'utf8'));

  let total = 0;
  for (const mode of ['default', 'advanced']) {
    const modeDir = path.join(outDir, mode);
    const filtered = filterDocsForMode(docs, mode);
    for (const doc of filtered) {
      const dest = path.join(modeDir, doc.key);
      await fs.mkdir(path.dirname(dest), { recursive: true });
      await fs.writeFile(dest, doc.content, 'utf8');
      total++;
    }
    console.log(`[materialize:agent-seed] mode=${mode}: wrote ${filtered.length} file(s)`);
  }
  console.log(`[materialize:agent-seed] Wrote ${total} file(s) to ${path.relative(process.cwd(), outDir) || outDir}`);
}

// Only run when invoked directly (not when imported by the drift-guard test).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('[materialize:agent-seed] Failed:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
