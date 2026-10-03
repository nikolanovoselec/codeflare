import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, it } from 'node:test';

function sharedTabs(agent) {
  const values = new Map();
  const storage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: key => values.delete(key),
  };
  const context = {};
  const path = fileURLToPath(new URL(`../../preseed/agents/${agent}/skills/impeccable/scripts/live-browser-session.js`, import.meta.url));
  runInNewContext(readFileSync(path, 'utf8'), context);
  const create = context.__IMPECCABLE_LIVE_SESSION__.createLiveBrowserSessionState;
  return [create({ prefix: 'review', storage }), create({ prefix: 'review', storage })];
}

for (const agent of ['claude', 'pi']) {
  describe(`${agent} Impeccable live browser session`, () => {
    it('REQ-AGENT-181: stale saves retain an observed newer checkpoint revision', () => {
      const [stale, current] = sharedTabs(agent);
      current.saveSession({ id: 'session' });
      current.nextCheckpointRevision();
      const revision = current.nextCheckpointRevision();
      stale.saveSession({ id: 'session', url: 'https://preview.example/updated' });
      const restored = current.loadSession();
      assert.equal(restored.checkpointRevision, revision);
      assert.equal(restored.url, 'https://preview.example/updated');
    });

    it('REQ-AGENT-181: stale checkpoint advancement exceeds the observed stored revision', () => {
      const [stale, current] = sharedTabs(agent);
      current.saveSession({ id: 'session' });
      current.nextCheckpointRevision();
      const revision = current.nextCheckpointRevision();
      const advanced = stale.nextCheckpointRevision();
      assert.equal(advanced, revision + 1);
      assert.equal(current.loadSession().checkpointRevision, advanced);
    });
  });
}
