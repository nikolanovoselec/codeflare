import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('preseed review timeout follow-up', () => {
  it('recognizes native CI-monitor timeout completion in the shipped Pi extension', () => {
    const source = readFileSync(resolve(process.cwd(), 'preseed/agents/pi/extensions/review-helpers.ts'), 'utf8');
    expect(source).toContain('Command timed out after');
    expect(source).toContain('?? "timeout"');
  });
});
