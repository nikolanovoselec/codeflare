#!/usr/bin/env node

import { readdirSync, rmSync, statSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAMILIES = Object.freeze([
  Object.freeze({ directory: '@anthropic-ai', prefix: 'claude-code', keep: Object.freeze(['claude-code', 'claude-code-linux-x64']) }),
  Object.freeze({ directory: '@github', prefix: 'copilot', keep: Object.freeze(['copilot', 'copilot-linux-x64']) }),
  Object.freeze({ directory: '@openai', prefix: 'codex', keep: Object.freeze(['codex', 'codex-linux-x64']) }),
  Object.freeze({ directory: '', prefix: 'opencode-', keep: Object.freeze(['opencode-ai', 'opencode-linux-x64']) }),
]);

function fileBytes(path) {
  const metadata = statSync(path);
  if (!metadata.isDirectory()) return metadata.size;
  return readdirSync(path, { withFileTypes: true })
    .reduce((total, entry) => total + fileBytes(join(path, entry.name)), 0);
}

export function pruneNpmPlatformArtifacts(nodeModulesPath) {
  const root = resolve(nodeModulesPath);
  const removed = [];
  let bytesRemoved = 0;

  for (const family of FAMILIES) {
    const familyRoot = join(root, family.directory);
    let entries;
    try {
      entries = readdirSync(familyRoot, { withFileTypes: true });
    } catch (error) {
      if (error?.code === 'ENOENT') continue;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(family.prefix) || family.keep.includes(entry.name)) continue;
      const path = join(familyRoot, entry.name);
      bytesRemoved += fileBytes(path);
      removed.push(relative(root, path).split(sep).join('/'));
      rmSync(path, { recursive: true, force: true });
    }
  }

  return { bytesRemoved, removed };
}

function main() {
  const nodeModulesPath = process.argv[2];
  if (!nodeModulesPath) throw new Error('usage: prune-npm-platform-artifacts.mjs <node_modules>');
  process.stdout.write(`${JSON.stringify(pruneNpmPlatformArtifacts(nodeModulesPath))}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
