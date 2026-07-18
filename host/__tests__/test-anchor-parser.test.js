import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseTestAnchors } from '../../preseed/agents/claude/skills/spec-enforce-truth/references/parse-test-anchors.mjs';

describe('test-anchor parser', () => {
  it('REQ-AGENT-094 AC1: accepts one or more anchors per AC in declaration order', () => {
    const ac = '1. Observable behavior. ' +
      '<!-- @test: src/a.test.ts (handles the default case) --> ' +
      '<!-- @test: src/b.test.ts (handles retry (bounded)) -->';

    assert.deepEqual(parseTestAnchors(ac), [
      { path: 'src/a.test.ts', blockTitle: 'handles the default case' },
      { path: 'src/b.test.ts', blockTitle: 'handles retry (bounded)' },
    ]);
  });

  it('preserves a single anchor and ignores unrelated comments', () => {
    const ac = '1. Observable behavior. ' +
      '<!-- @impl: src/service.ts::run --> ' +
      '<!-- @test: src/service.test.ts (run rejects invalid input) --> ' +
      '<!-- @manual: supplemental verification -->';

    assert.deepEqual(parseTestAnchors(ac), [
      { path: 'src/service.test.ts', blockTitle: 'run rejects invalid input' },
    ]);
  });

  it('rejects incomplete anchor comments instead of returning partial evidence', () => {
    const ac = '1. Observable behavior. <!-- @test: src/service.test.ts (missing comment close)';

    assert.deepEqual(parseTestAnchors(ac), []);
  });
});
