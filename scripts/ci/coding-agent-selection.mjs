#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import {
  CODING_AGENTS,
  hasCodingAgent,
  resolveCodingAgents,
} from './coding-agent-selection-core.mjs';

export {
  CODING_AGENTS,
  CODING_AGENT_ROOTS,
  codingAgentProjectionIdentity,
  hasCodingAgent,
  isCodingAgentProjectionIdentity,
  managedPathOwner,
  resolveCodingAgents,
} from './coding-agent-selection-core.mjs';

export const CODING_AGENT_COMMANDS = Object.freeze({
  'claude-code': Object.freeze({ path: '/usr/local/bin/claude', args: ['--version'] }),
  codex: Object.freeze({ path: '/usr/local/bin/codex', args: ['--version'] }),
  copilot: Object.freeze({ path: '/usr/local/bin/copilot', args: ['--version'] }),
  antigravity: Object.freeze({ path: '/usr/local/bin/agy', args: ['--version'] }),
  opencode: Object.freeze({ path: '/usr/local/bin/opencode', args: ['--version'] }),
  pi: Object.freeze({ path: '/usr/local/bin/pi', args: ['--version'] }),
});

const NPM_AGENT_PACKAGES = Object.freeze({
  'claude-code': '@anthropic-ai/claude-code',
  codex: '@openai/codex',
  copilot: '@github/copilot',
  opencode: 'opencode-ai',
  pi: '@earendil-works/pi-coding-agent',
});

/** Return a fresh manifest whose coding-agent roots match the selected image set. */
export function selectedNpmManifest(manifest, rawSelection) {
  const selected = new Set(resolveCodingAgents(rawSelection).split(','));
  const agentPackages = new Set(Object.values(NPM_AGENT_PACKAGES));
  const dependencies = Object.fromEntries(
    Object.entries(manifest.dependencies ?? {}).filter(([name]) => {
      if (!agentPackages.has(name)) return true;
      const agent = Object.entries(NPM_AGENT_PACKAGES).find(([, packageName]) => packageName === name)?.[0];
      return agent !== undefined && selected.has(agent);
    }),
  );
  return { ...manifest, dependencies };
}

function usage() {
  return 'Usage: coding-agent-selection.mjs resolve [selection] | has <selection> <agent> | select-manifest <selection> <package.json>';
}

function main(argv) {
  const [command, ...args] = argv;
  if (command === 'resolve' && args.length <= 1) {
    process.stdout.write(`${resolveCodingAgents(args[0])}\n`);
    return;
  }
  if (command === 'has' && args.length === 2) {
    process.exitCode = hasCodingAgent(args[0], args[1]) ? 0 : 1;
    return;
  }
  if (command === 'select-manifest' && args.length === 2) {
    const [selection, manifestPath] = args;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    writeFileSync(manifestPath, `${JSON.stringify(selectedNpmManifest(manifest, selection), null, 2)}\n`);
    return;
  }
  throw new Error(usage());
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
