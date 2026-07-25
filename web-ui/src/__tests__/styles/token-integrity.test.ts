/// <reference types="node" />
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { resolve, join } from 'path';

// Regression guard for a defect class that rots silently: a `var(--x)` whose
// token is never defined makes the whole declaration invalid at computed-value
// time, so the element just inherits and nothing errors. Several of these
// survived for months (--color-danger painted no colour on error states).
// A reference that carries a fallback is fine — the fallback renders — and some
// tokens are legitimately injected per-element at runtime, which is exactly why
// only the no-fallback references are asserted here. Tokens assigned solely via
// element.style.setProperty() are not seen as definitions; today every such
// token is also defined statically, and a future runtime-only one would fail
// loudly by name rather than slip through.
const SRC = resolve(__dirname, '../..');
const SKIP = /(^|\/)(__tests__|node_modules)(\/|$)/;

function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP.test(full)) sourceFiles(full, acc);
    } else if (/\.(css|tsx|ts)$/.test(entry.name) && !SKIP.test(full)) {
      acc.push(full);
    }
  }
  return acc;
}

describe('design token integrity', () => {
  it('every var() reference without a fallback resolves to a defined token', () => {
    const defined = new Set<string>();
    const dangling: string[] = [];
    const files = sourceFiles(SRC);
    const references: Array<{ name: string; file: string }> = [];

    for (const file of files) {
      const text = readFileSync(file, 'utf-8');
      // `--x: value` in a stylesheet, and `'--x': value` in an inline style object
      for (const m of text.matchAll(/^\s*(--[a-zA-Z0-9-]+)\s*:/gm)) defined.add(m[1]);
      for (const m of text.matchAll(/['"](--[a-zA-Z0-9-]+)['"]\s*:/g)) defined.add(m[1]);
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
