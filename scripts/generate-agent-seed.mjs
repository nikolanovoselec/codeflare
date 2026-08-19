#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { generateAgentSeed } from './agent-seed-core.mjs';

export async function main() {
  await generateAgentSeed();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error('[generate:agent-seed] Failed:', error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
