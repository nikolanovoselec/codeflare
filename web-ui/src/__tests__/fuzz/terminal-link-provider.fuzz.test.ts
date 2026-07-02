/**
 * Property-based fuzz tests for the multi-line terminal link provider
 * (REQ-TERM-015). The provider runs regexes over joined terminal-buffer
 * rows — content an attacker can influence simply by getting bytes printed
 * to the terminal (`cat`ing a hostile file is enough), so it must never
 * throw, never backtrack catastrophically (ReDoS), and only ever emit
 * links whose text is a plausible URL.
 *
 * Same harness contract as frontend-fuzz.test.ts: CI runs 50k iterations
 * (FAST_CHECK_NUM_RUNS); local runs 1k.
 */
import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { registerMultiLineLinkProvider, type XTermBuffer } from '../../lib/terminal-link-provider';
import type { Terminal as XTerm, ILinkProvider, ILink, IDisposable } from '@xterm/xterm';

const NUM_RUNS = parseInt(process.env.FAST_CHECK_NUM_RUNS || '1000');

interface FuzzRow {
  text: string;
  wrapped: boolean;
}

function makeBuffer(rows: FuzzRow[]): XTermBuffer {
  return {
    length: rows.length,
    getLine(y: number) {
      const row = rows[y];
      if (!row) return undefined;
      return {
        translateToString: () => row.text,
        isWrapped: row.wrapped,
      };
    },
  };
}

/** Capture the provider callback through the real registration path. */
function captureProvider(rows: FuzzRow[], cols: number): { provider: ILinkProvider; dispose: IDisposable } {
  let provider: ILinkProvider | undefined;
  const fakeTerminal = {
    cols,
    buffer: { active: makeBuffer(rows) },
    registerLinkProvider(p: ILinkProvider): IDisposable {
      provider = p;
      return { dispose() {} };
    },
  } as unknown as XTerm;
  const dispose = registerMultiLineLinkProvider(fakeTerminal);
  if (!provider) throw new Error('provider was not registered');
  return { provider, dispose };
}

function provideLinksSync(provider: ILinkProvider, y: number): { links: ILink[] | undefined; calls: number } {
  let links: ILink[] | undefined;
  let calls = 0;
  provider.provideLinks(y, (l) => {
    links = l;
    calls += 1;
  });
  return { links, calls };
}

// Row content mixes plain noise, URL-bearing text, and TUI-decorated rows
// (the Bubble Tea / ink border case the heuristic joiner exists for).
const rowTextArb = fc.oneof(
  fc.string({ maxLength: 160 }),
  fc
    .tuple(fc.string({ maxLength: 24 }), fc.string({ maxLength: 80 }))
    .map(([pre, tail]) => `${pre}https://example.com/${tail}`),
  fc
    .tuple(fc.string({ maxLength: 60 }), fc.string({ maxLength: 40 }))
    .map(([body, tail]) => `│ ${body}https://a.b/${tail} │`),
);
const rowsArb = fc.array(
  fc.record({ text: rowTextArb, wrapped: fc.boolean() }),
  { minLength: 1, maxLength: 24 },
);
const colsArb = fc.constantFrom(20, 80, 120);

describe('fuzz: registerMultiLineLinkProvider', () => {
  it('never throws and calls back exactly once for any buffer content and any queried row', () => {
    fc.assert(
      fc.property(rowsArb, colsArb, fc.integer({ min: 0, max: 30 }), (rows, cols, yOffset) => {
        const { provider } = captureProvider(rows, cols);
        // xterm passes 1-based line numbers; also probe out-of-range rows.
        const { calls } = provideLinksSync(provider, 1 + yOffset);
        expect(calls).toBe(1);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('every emitted link is an http(s) URL with a valid activate handler and ordered range', () => {
    fc.assert(
      fc.property(rowsArb, colsArb, (rows, cols) => {
        const { provider } = captureProvider(rows, cols);
        for (let y = 1; y <= rows.length; y++) {
          const { links } = provideLinksSync(provider, y);
          for (const link of links ?? []) {
            // The URL regex char class excludes whitespace and quote/angle chars;
            // an emitted link violating this means boundary-stripping regressed.
            expect(link.text).toMatch(/^https?:\/\/[^\s"'<>]+$/);
            expect(typeof link.activate).toBe('function');
            const { start, end } = link.range;
            expect(end.y).toBeGreaterThanOrEqual(start.y);
            if (end.y === start.y) expect(end.x).toBeGreaterThanOrEqual(start.x);
          }
        }
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('resists catastrophic backtracking on adversarial URL-shaped rows (ReDoS bound)', () => {
    // Long runs of regex-ambiguous URL characters across wrapped rows are the
    // worst case for the joiner + matcher. Bound the per-query wall clock.
    const adversarialRow = fc
      .tuple(
        fc.constantFrom('https://x.y/', 'http://'),
        fc.array(fc.constantFrom('a', '/', '?', '&', '=', '%', '.', '-', '('), { minLength: 100, maxLength: 500 }),
      )
      .map(([scheme, chars]) => ({ text: scheme + chars.join(''), wrapped: true }));
    fc.assert(
      fc.property(fc.array(adversarialRow, { minLength: 1, maxLength: 12 }), (rows) => {
        const { provider } = captureProvider(rows as FuzzRow[], 80);
        const started = performance.now();
        provideLinksSync(provider, 1);
        expect(performance.now() - started).toBeLessThan(250);
      }),
      { numRuns: Math.min(NUM_RUNS, 2000) }, // wall-clock-bounded property; capped explicitly, not silently
    );
  });
});
