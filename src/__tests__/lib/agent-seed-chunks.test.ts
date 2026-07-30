import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AGENTS_SEEDED_CONFIGS,
  PRESEED_CONTENT_HASH,
  RETIRED_PRESEED_KEYS,
} from '../../lib/agent-seed.generated';

const MAX_CHUNK_BYTES = 2_000_000;
const generatedDir = path.resolve(process.cwd(), 'src/lib');

describe('generated agent seed module boundaries', () => {
  it('keeps every generated module below the Worker test transport ceiling', () => {
    const files = readdirSync(generatedDir)
      .filter((name) => /^agent-seed\.generated(?:\.\d{3})?\.ts$/.test(name))
      .sort();

    expect(files.length).toBeGreaterThan(1);
    for (const file of files) {
      expect(statSync(path.join(generatedDir, file)).size, file).toBeLessThanOrEqual(MAX_CHUNK_BYTES);
    }
  });

  it('aggregates the complete ordered document set under its unchanged content hash', () => {
    expect(AGENTS_SEEDED_CONFIGS.length).toBeGreaterThan(1_000);
    const sorted = [...AGENTS_SEEDED_CONFIGS].sort((a, b) => a.key.localeCompare(b.key));
    const hash = createHash('sha256')
      .update(JSON.stringify({ documents: sorted, retired: RETIRED_PRESEED_KEYS }))
      .digest('hex')
      .slice(0, 16);

    expect(hash).toBe(PRESEED_CONTENT_HASH);

    const aggregator = readFileSync(path.join(generatedDir, 'agent-seed.generated.ts'), 'utf8');
    const imports = [...aggregator.matchAll(/agent-seed\.generated\.\d{3}/g)].map(([name]) => name);
    const chunks = readdirSync(generatedDir).filter((name) => /^agent-seed\.generated\.\d{3}\.ts$/.test(name));
    expect(new Set(imports).size).toBe(chunks.length);
  });
});
