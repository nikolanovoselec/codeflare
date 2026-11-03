#!/usr/bin/env node
// One candidate gate for the image, real-Pi CI and dependency-bump transaction.
// Missing candidates/dependencies are errors, never skipped or substituted.
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { prepareHostedOAuth } from './patch-pi-mcp-hosted-oauth.mjs';
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
prepareHostedOAuth(join(root, 'preseed/agents/pi/node_modules/pi-mcp-extension'), {
  selectedManifest: join(root, 'preseed/agents/pi/package.json'),
  selectedLock: join(root, 'preseed/agents/pi/package-lock.json'),
  companionPath: join(root, 'preseed/agents/pi/extensions/mcp-portal-oauth.ts'),
});
const result = spawnSync(process.execPath, ['--test',
  'host/__tests__/mcp-hosted-oauth.test.js',
  'host/__tests__/mcp-oauth-return-channel.test.js',
  'preseed/agents/pi/test/consult-proxy.test.mjs',
], { cwd: root, env: process.env, stdio: 'inherit' });
if (result.error || result.signal || result.status !== 0) process.exit(1);
