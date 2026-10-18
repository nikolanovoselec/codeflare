import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { loadFauxProvider } from '../../scripts/measure-pi-runtime-context.mjs';

// REQ-AGENT-097 AC1 / REQ-AGENT-158 AC5: offline measurement must load the
// selected SDK's public provider, not depend on an npm nesting/private-path layout.
describe('Pi runtime context provider selection', () => {
  for (const layout of ['hoisted', 'nested']) {
    it(`loads the selected SDK's public faux provider when ${layout}`, async () => {
      const directory = await mkdtemp(path.join(tmpdir(), 'pi-context-'));
      try {
        const sdkRoot = path.join(directory, 'node_modules/@earendil-works/pi-coding-agent');
        const aiRoot = path.join(layout === 'nested' ? sdkRoot : directory, 'node_modules/@earendil-works/pi-ai');
        await mkdir(sdkRoot, { recursive: true });
        await mkdir(path.join(aiRoot, 'public'), { recursive: true });
        await writeFile(path.join(sdkRoot, 'package.json'), JSON.stringify({
          name: '@earendil-works/pi-coding-agent', type: 'module',
        }));
        await writeFile(path.join(aiRoot, 'package.json'), JSON.stringify({
          name: '@earendil-works/pi-ai', type: 'module',
          exports: { './providers/*': { import: './public/*-entry.mjs' } },
        }));
        await writeFile(path.join(aiRoot, 'public/faux-entry.mjs'),
          `export const fauxAssistantMessage = text => ({ role: 'assistant', content: text });
           export const createFauxCore = () => ({ models: [{ id: '${layout}' }] });`);
        const provider = await loadFauxProvider(sdkRoot);
        assert.deepEqual(provider.fauxAssistantMessage('offline'), { role: 'assistant', content: 'offline' });
        assert.deepEqual(provider.createFauxCore({}).models, [{ id: layout }]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }

  it('refuses a provider without a public ESM export rather than loading a legacy private file', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'pi-context-'));
    try {
      const sdkRoot = path.join(directory, 'node_modules/@earendil-works/pi-coding-agent');
      const aiRoot = path.join(directory, 'node_modules/@earendil-works/pi-ai');
      await mkdir(sdkRoot, { recursive: true });
      await mkdir(path.join(aiRoot, 'dist/providers'), { recursive: true });
      await writeFile(path.join(sdkRoot, 'package.json'), JSON.stringify({
        name: '@earendil-works/pi-coding-agent', type: 'module',
      }));
      await writeFile(path.join(aiRoot, 'package.json'), JSON.stringify({
        name: '@earendil-works/pi-ai', type: 'module',
        exports: { './providers/*': { require: './dist/providers/*.js' } },
      }));
      await writeFile(path.join(aiRoot, 'dist/providers/faux.js'), 'export const createFauxCore = () => ({});');
      await assert.rejects(loadFauxProvider(sdkRoot), /Provisioned Pi AI public faux import is incompatible/);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
