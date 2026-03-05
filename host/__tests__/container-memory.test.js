import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const containerSource = readFileSync(
  resolve(__dirname, '../../src/container/index.ts'),
  'utf8'
);

// ============================================================================
// Test: Container memory support — SESSION_ID in environment
// ============================================================================
describe('Container memory support', () => {
  describe('SESSION_ID in environment', () => {
    it('envVars includes SESSION_ID', () => {
      // Find the envVars assignment block and check it contains SESSION_ID
      const envVarsMatch = containerSource.match(/this\.envVars\s*=\s*\{[^}]*\}/s);
      assert.ok(envVarsMatch, 'envVars assignment block should exist');
      assert.ok(
        envVarsMatch[0].includes('SESSION_ID'),
        'envVars should include SESSION_ID environment variable'
      );
    });

    it('_sessionId property exists', () => {
      assert.ok(
        containerSource.includes('_sessionId'),
        'container class should have _sessionId property'
      );
    });

    it('_sessionId loaded in constructor blockConcurrencyWhile', () => {
      // Find blockConcurrencyWhile block and check it references SESSION_ID_KEY for _sessionId
      const blockMatch = containerSource.match(
        /blockConcurrencyWhile\s*\(\s*async\s*\(\)\s*=>\s*\{[\s\S]*?\}\s*\)/
      );
      assert.ok(blockMatch, 'blockConcurrencyWhile block should exist in constructor');
      assert.ok(
        blockMatch[0].includes('SESSION_ID_KEY') || blockMatch[0].includes('_sessionId'),
        'blockConcurrencyWhile should load _sessionId from storage'
      );
    });
  });
});
