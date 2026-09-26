import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createIsolatedPiTools, parseIsolatedPiInitialization } from '../dist/operator-pi-isolated.js';

const init = { schemaVersion: 1, profileId: 'approved-profile', contextPath: 'review/input.json', context: '{}',
  inputs: [
    { kind: 'attachment', reference: 'packet-code.json', target: 'review/packets/code.json' },
    { kind: 'resource', reference: 'review/child.md', target: 'review/resources/child.md' },
    { kind: 'resource', reference: 'review/other.md', target: 'review/resources/other.md' },
  ], tasks: [
    { id: 'code', instruction: 'review/resources/child.md',
      reads: ['review/input.json', 'review/packets/code.json', 'review/resources/child.md'], output: 'reports/code.json' },
    { id: 'other', instruction: 'review/resources/other.md',
      reads: ['review/input.json', 'review/resources/other.md'], output: 'reports/other.json' },
  ] };
const sdk = {
  createReadToolDefinition: (_cwd, options) => ({ name: 'read', execute: async (_id, args) => {
    const file = path.resolve(_cwd, args.path);
    await options.operations.access(file);
    return { content: [{ type: 'text', text: (await options.operations.readFile(file)).toString('utf8') }] };
  } }),
  createWriteToolDefinition: (_cwd, options) => ({ name: 'write', execute: async (_id, args) => {
    const file = path.resolve(_cwd, args.path);
    await options.operations.mkdir(path.dirname(file));
    await options.operations.writeFile(file, args.content);
    return { content: [{ type: 'text', text: 'written' }] };
  } }),
};

test('REQ-OPERATOR-021: each SDK child sees only its declared inputs and can stage one immutable bounded output', async t => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'isolated-pi-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  for (const relative of [init.contextPath, ...init.inputs.map(item => item.target)]) {
    await mkdir(path.dirname(path.join(cwd, relative)), { recursive: true });
    await writeFile(path.join(cwd, relative), `approved:${relative}`);
  }
  const outside = path.join(cwd, 'secret');
  await writeFile(outside, 'private');
  const [read, write] = createIsolatedPiTools(sdk, cwd, parseIsolatedPiInitialization(init), init.tasks[0]);
  assert.equal((await read.execute('context', { path: init.contextPath })).content[0].text,
    `approved:${init.contextPath}`);
  for (const file of ['secret', '../secret', 'review/resources/other.md',
    path.join(cwd, init.contextPath), 'review/packets/../input.json']) {
    await assert.rejects(read.execute('unauthorized', { path: file }));
  }
  await rm(path.join(cwd, init.contextPath));
  await symlink(outside, path.join(cwd, init.contextPath));
  await assert.rejects(read.execute('linked', { path: init.contextPath }));
  for (const file of ['reports/other.json', 'review/input.json', '../secret']) {
    await assert.rejects(write.execute('unauthorized', { path: file, content: '{}' }));
  }
  await assert.rejects(write.execute('oversized', { path: 'reports/code.json', content: 'x'.repeat(65 * 1024) }));
  await assert.rejects(write.execute('invalid-utf8', { path: 'reports/code.json', content: '\ud800' }));
  await Promise.all([write.execute('first', { path: 'reports/code.json', content: '{"status":"complete"}' }),
    write.execute('same', { path: 'reports/code.json', content: '{"status":"complete"}' })]);
  await assert.rejects(write.execute('conflict', { path: 'reports/code.json', content: '{"status":"changed"}' }));
  assert.equal(await readFile(path.join(cwd, 'reports/code.json'), 'utf8'), '{"status":"complete"}');
  assert.equal(await readFile(outside, 'utf8'), 'private');
});
