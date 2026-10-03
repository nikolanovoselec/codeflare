import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { it } from 'node:test';

const requirePreseed = createRequire(new URL('../package.json', import.meta.url));
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

it('REQ-AGENT-081 AC1: pinned rpiv-todo isolates foreground tasks through child/background lifecycles and switching back', async () => {
  const manifest = readJson(new URL('../package.json', import.meta.url));
  const todoManifestPath = requirePreseed.resolve('@juicesharp/rpiv-todo/package.json');
  const todoManifest = readJson(todoManifestPath);
  // Intentional version contract: exercise the published artifact pinned by preseed, never a global fallback.
  assert.equal(manifest.dependencies['@juicesharp/rpiv-todo'], '2.11.0');
  assert.equal(todoManifest.version, '2.11.0');

  const sdkEntry = new URL(import.meta.resolve('@earendil-works/pi-coding-agent'));
  const { SessionManager } = await import(sdkEntry.href);
  // Pi's distributed loader evaluates the complete published TypeScript extension and its dependencies.
  const { loadExtensions } = await import(new URL('./core/extensions/loader.js', sdkEntry).href);
  const cwd = dirname(todoManifestPath);
  const loaded = await loadExtensions(todoManifest.pi.extensions.map((entry) => resolve(cwd, entry)), cwd);
  if (loaded.errors.length) throw new Error(JSON.stringify(loaded.errors));
  const extension = loaded.extensions[0];
  const todo = extension.tools.get('todo').definition;

  // Only the host API boundary is simulated; session storage, extension handlers, and tool execution are real.
  const context = (hasUI) => ({
    sessionManager: SessionManager.inMemory(cwd),
    hasUI,
    ui: { setWidget() {} },
  });
  const foreground = context(true);
  const child = context(true);
  const background = context(false);
  const emit = async (type, ctx, fields = {}) => {
    for (const handler of extension.handlers.get(type) ?? []) await handler({ type, ...fields }, ctx);
  };
  let callId = 0;
  const call = async (ctx, params) => {
    const toolCallId = `todo-isolation-${++callId}`;
    const result = await todo.execute(toolCallId, params, undefined, undefined, ctx);
    assert.equal(result.details.error, undefined);
    ctx.sessionManager.appendMessage({
      role: 'toolResult', toolCallId, toolName: 'todo',
      content: result.content, details: result.details, isError: false, timestamp: Date.now(),
    });
    await emit('tool_execution_end', ctx, { toolCallId, toolName: 'todo', result, isError: false });
    return result;
  };
  const tasks = async (ctx) => (await call(ctx, { action: 'list' })).details.tasks
    .map(({ id, subject, status }) => ({ id, subject, status }));
  const expectedForeground = [
    { id: 1, subject: 'Retain foreground task', status: 'pending' },
    { id: 2, subject: 'Retain second foreground task', status: 'pending' },
  ];

  try {
    await emit('session_start', foreground);
    for (const { subject } of expectedForeground) await call(foreground, { action: 'create', subject });
    assert.deepEqual(await tasks(foreground), expectedForeground);

    for (const [ctx, subject] of [[child, 'Child-only task'], [background, 'Background-only task']]) {
      await emit('session_start', ctx);
      assert.deepEqual(await tasks(ctx), []);
      await call(ctx, { action: 'create', subject });
      const expectedOwn = [{ id: 1, subject, status: 'pending' }];
      assert.deepEqual(await tasks(ctx), expectedOwn);
      assert.deepEqual(await tasks(foreground), expectedForeground);
      for (const type of ['session_compact', 'session_tree']) {
        await emit(type, ctx);
        assert.deepEqual(await tasks(ctx), expectedOwn);
        assert.deepEqual(await tasks(foreground), expectedForeground);
      }
      await emit('session_shutdown', ctx);
      assert.deepEqual(await tasks(foreground), expectedForeground);
    }

    // Switching away and back replays the original manager, not either sibling's last snapshot.
    await emit('session_shutdown', foreground);
    await emit('session_start', background);
    assert.deepEqual(await tasks(background), [{ id: 1, subject: 'Background-only task', status: 'pending' }]);
    await emit('session_shutdown', background);
    await emit('session_start', foreground);
    assert.deepEqual(await tasks(foreground), expectedForeground);
    await call(foreground, { action: 'create', subject: 'Continue foreground after switching back' });
    assert.deepEqual(await tasks(foreground), [
      ...expectedForeground,
      { id: 3, subject: 'Continue foreground after switching back', status: 'pending' },
    ]);
  } finally {
    for (const ctx of [child, background, foreground]) await emit('session_shutdown', ctx);
  }
});
