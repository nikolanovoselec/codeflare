import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { md5 } from '../../lib/md5';
import { generateSessionName } from '../../lib/session-utils';
import { formatSize, formatRelativeTime } from '../../lib/format';
import { shouldUseMultipart, splitIntoParts } from '../../lib/file-upload';

const NUM_RUNS = parseInt(process.env.FAST_CHECK_NUM_RUNS || '1000');

// ---------------------------------------------------------------------------
// MD5
// ---------------------------------------------------------------------------
describe('fuzz: md5', () => {
  it('always produces a 32-char hex string', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const hash = md5(s);
        expect(hash).toMatch(/^[0-9a-f]{32}$/);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('is deterministic', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(md5(s)).toBe(md5(s));
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('matches known test vectors', () => {
    expect(md5('')).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5('abc')).toBe('900150983cd24fb0d6963f7d28e17f72');
  });

  it('never throws on any string input', () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        expect(() => md5(s)).not.toThrow();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('different inputs produce different hashes (statistical)', () => {
    fc.assert(
      fc.property(fc.string(), fc.string(), (a, b) => {
        fc.pre(a !== b);
        expect(md5(a)).not.toBe(md5(b));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// generateSessionName
// ---------------------------------------------------------------------------
describe('fuzz: generateSessionName', () => {
  const agentTypes = ['claude-code', 'codex', 'copilot', 'gemini', 'opencode', 'bash'] as const;

  it('always matches pattern ".+ #\\d+"', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...agentTypes),
        fc.array(fc.record({ name: fc.string() }), { maxLength: 50 }),
        (agentType, sessions) => {
          const name = generateSessionName(agentType, sessions);
          expect(name).toMatch(/.+ #\d+$/);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('N is always >= 1', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...agentTypes),
        fc.array(fc.record({ name: fc.string() }), { maxLength: 50 }),
        (agentType, sessions) => {
          const name = generateSessionName(agentType, sessions);
          const num = parseInt(name.split('#').pop()!, 10);
          expect(num).toBeGreaterThanOrEqual(1);
        },
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('returns #1 for empty sessions', () => {
    for (const agent of agentTypes) {
      const name = generateSessionName(agent, []);
      expect(name).toMatch(/#1$/);
    }
  });

  it('fills gaps: sessions [#1, #3] yields #2', () => {
    const name = generateSessionName('claude-code', [
      { name: 'Claude Code #1' },
      { name: 'Claude Code #3' },
    ]);
    expect(name).toBe('Claude Code #2');
  });

  it('undefined agentType uses "Session" label', () => {
    const name = generateSessionName(undefined, []);
    expect(name).toBe('Session #1');
  });
});

// ---------------------------------------------------------------------------
// formatSize
// ---------------------------------------------------------------------------
describe('fuzz: formatSize', () => {
  it('never throws for non-negative integers up to 1e12', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000_000_000 }), (n) => {
        expect(() => formatSize(n)).not.toThrow();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('output ends with B, KB, MB, or GB', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 1_000_000_000_000 }), (n) => {
        const result = formatSize(n);
        expect(result).toMatch(/ (B|KB|MB|GB)$/);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('formatSize(0) === "0 B"', () => {
    expect(formatSize(0)).toBe('0 B');
  });

  it('boundary values', () => {
    expect(formatSize(1024)).toBe('1.0 KB');
    expect(formatSize(1024 * 1024)).toBe('1.0 MB');
    expect(formatSize(1024 * 1024 * 1024)).toBe('1.0 GB');
  });
});

// ---------------------------------------------------------------------------
// formatRelativeTime
// ---------------------------------------------------------------------------
describe('fuzz: formatRelativeTime', () => {
  it('undefined returns "--"', () => {
    expect(formatRelativeTime(undefined)).toBe('--');
  });

  it('never throws for any Date', () => {
    fc.assert(
      fc.property(fc.date(), (d) => {
        expect(() => formatRelativeTime(d)).not.toThrow();
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('recent dates (< 10s ago) return "just now"', () => {
    const now = new Date();
    expect(formatRelativeTime(now)).toBe('just now');
    expect(formatRelativeTime(new Date(Date.now() - 5_000))).toBe('just now');
  });

  it('output is always a non-empty string', () => {
    fc.assert(
      fc.property(fc.date(), (d) => {
        const result = formatRelativeTime(d);
        expect(typeof result).toBe('string');
        expect(result.length).toBeGreaterThan(0);
      }),
      { numRuns: NUM_RUNS },
    );
  });
});

// ---------------------------------------------------------------------------
// shouldUseMultipart + splitIntoParts
// ---------------------------------------------------------------------------
describe('fuzz: file upload helpers', () => {
  function createMockFile(size: number): File {
    const file = new File([], 'test.bin');
    Object.defineProperty(file, 'size', { value: size });
    return file;
  }

  it('shouldUseMultipart is false for files <= 5MB', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 5 * 1024 * 1024 }), (size) => {
        expect(shouldUseMultipart(createMockFile(size))).toBe(false);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('shouldUseMultipart is true for files > 5MB', () => {
    fc.assert(
      fc.property(fc.integer({ min: 5 * 1024 * 1024 + 1, max: 500 * 1024 * 1024 }), (size) => {
        expect(shouldUseMultipart(createMockFile(size))).toBe(true);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('splitIntoParts returns at least 1 part', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 500 * 1024 * 1024 }), (size) => {
        const file = createMockFile(size);
        // splitIntoParts calls file.slice() which works on the real Blob (empty),
        // but the loop is driven by the mocked .size property
        const parts = splitIntoParts(file);
        expect(parts.length).toBeGreaterThanOrEqual(1);
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('number of parts matches ceil(size / partSize)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 500 * 1024 * 1024 }), (size) => {
        const file = createMockFile(size);
        const parts = splitIntoParts(file);
        const partSize = size > 100 * 1024 * 1024 ? 10 * 1024 * 1024 : 5 * 1024 * 1024;
        expect(parts.length).toBe(Math.ceil(size / partSize));
      }),
      { numRuns: NUM_RUNS },
    );
  });
});
