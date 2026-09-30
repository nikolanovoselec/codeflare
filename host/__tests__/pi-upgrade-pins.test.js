import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const read = (path) => JSON.parse(readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8'));

// Intentional release-pin contract: both runtime trees must ship the approved update.
describe('REQ-AGENT-206: approved Pi crash-recovery release pins', () => {
  it('pins the runtime and extension host to Pi 0.99.1 with the requested extension updates', () => {
    const tools = read('preseed/npm-tools/package.json');
    const pi = read('preseed/agents/pi/package.json');
    assert.equal(tools.dependencies['@earendil-works/pi-coding-agent'], '0.99.1');
    assert.equal(pi.dependencies['@earendil-works/pi-coding-agent'], '0.99.1');
    for (const name of ['pi-ai', 'pi-tui', 'pi-agent-core']) {
      assert.equal(pi.devDependencies[`@earendil-works/${name}`], '0.99.1');
    }
    for (const [name, version] of Object.entries({
      '@gotgenes/pi-subagents': '21.8.1',
      '@juicesharp/rpiv-advisor': '2.11.0',
      '@juicesharp/rpiv-ask-user-question': '2.11.0',
      '@juicesharp/rpiv-todo': '2.11.0',
      'pi-web-access': '0.34.0',
      'pi-mcp-adapter': '3.3.0',
    })) assert.equal(pi.dependencies[name], version, name);
  });
});
