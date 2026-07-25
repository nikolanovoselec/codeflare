import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

// Same guard as web-ui's token-integrity test: a `var(--x)` with no fallback and
// no definition invalidates the whole declaration silently. Landing sets some
// tokens per-element from markup (`style={`--i:${i}`}`), so .astro files count
// as definition sources and fallback-carrying references are excluded.
const SRC = resolve(__dirname, '..');
const SKIP = /(^|\/)(__tests__|node_modules)(\/|$)/;

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP.test(full)) sourceFiles(full, acc);
    } else if (/\.(css|astro|ts|tsx)$/.test(entry.name) && !SKIP.test(full)) {
      acc.push(full);
    }
  }
  return acc;
}

describe('landing design token integrity', () => {
  it('every var() reference without a fallback resolves to a defined token', () => {
    const defined = new Set<string>();
    const dangling: string[] = [];
    const files = sourceFiles(SRC);
    const references: Array<{ name: string; file: string }> = [];

    for (const file of files) {
      const text = readFileSync(file, 'utf-8');
      for (const m of text.matchAll(/^\s*(--[a-zA-Z0-9-]+)\s*:/gm)) defined.add(m[1]);
      for (const m of text.matchAll(/['"](--[a-zA-Z0-9-]+)['"]\s*:/g)) defined.add(m[1]);
      // inline style strings in markup: style={`--i:${i}`} / style="--i:0"
      for (const m of text.matchAll(/style=[{"'`\s]*(--[a-zA-Z0-9-]+)\s*:/g)) defined.add(m[1]);
      for (const m of text.matchAll(/var\(\s*(--[a-zA-Z0-9-]+)\s*([,)])/g)) {
        if (m[2] === ')') references.push({ name: m[1], file: file.slice(SRC.length + 1) });
      }
    }

    expect(files.length).toBeGreaterThan(0);
    expect(defined.size).toBeGreaterThan(0);

    for (const ref of references) {
      if (!defined.has(ref.name)) dangling.push(`${ref.name} (${ref.file})`);
    }

    expect(dangling).toEqual([]);
  });
});
