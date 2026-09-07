#!/usr/bin/env node
// Applies Codeflare's reviewed compatibility patch to Plan Mode 0.55.3 and 0.56.0.
// Upstream 0.55 resolves policy from active tools and requires helper tools to
// already be active before /plan starts. Codeflare exposes only five bootstrap
// tools to ordinary provider turns, so the image patch resolves Plan policy from
// registered tools while the late exposure finalizer activates only the frozen
// Plan policy and helper tools for Plan turns.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const EXPECTED_PI_PLAN_MODE_VERSION = '0.55.3';
const SUPPORTED_VERSIONS = [EXPECTED_PI_PLAN_MODE_VERSION, '0.56.0'];
const PARSED_POLICY_MARKER = 'CODEFLARE_PLAN_PARSED_COMMAND_POLICY';
export const REGISTERED_HELPERS_MARKER = 'CODEFLARE_PLAN_REGISTERED_HELPERS';
export const REGISTERED_POLICY_MARKER = 'CODEFLARE_PLAN_REGISTERED_POLICY';

const ACTIVE_HELPERS = 'assertPlanModeHelperToolsAvailable(safeGetActiveTools());';
const REGISTERED_HELPERS = 'assertPlanModeHelperToolsAvailable(safeGetAllTools().map((tool) => tool.name)); // CODEFLARE_PLAN_REGISTERED_HELPERS';

const SOURCE_ACTIVE_POLICY = `\tfunction activePlanPolicyTools() {
\t\tconst activeNames = new Set(safeGetActiveTools());
\t\treturn selectableTools().filter((tool) => activeNames.has(tool.name));
\t}`;
const SOURCE_REGISTERED_POLICY = `\tfunction activePlanPolicyTools() {
\t\treturn selectableTools(); // CODEFLARE_PLAN_REGISTERED_POLICY
\t}`;
const DIST_ACTIVE_POLICY = `  function activePlanPolicyTools() {
    const activeNames = new Set(safeGetActiveTools());
    return selectableTools().filter((tool) => activeNames.has(tool.name));
  }`;
const DIST_REGISTERED_POLICY = `  function activePlanPolicyTools() {
    return selectableTools(); // CODEFLARE_PLAN_REGISTERED_POLICY
  }`;

function count(source, value) {
  return source.split(value).length - 1;
}

export function patchPiPlanModeSource(source, kind) {
  if (source.includes(REGISTERED_HELPERS_MARKER) || source.includes(REGISTERED_POLICY_MARKER)) {
    if (count(source, REGISTERED_HELPERS_MARKER) !== 2 || count(source, REGISTERED_POLICY_MARKER) !== 1) {
      throw new Error(`Plan Mode ${kind} contains an incomplete Codeflare compatibility patch`);
    }
    return source;
  }
  if (count(source, ACTIVE_HELPERS) !== 2) {
    throw new Error(`Plan Mode ${kind} helper anchor count ${count(source, ACTIVE_HELPERS)}; expected 2`);
  }
  const activePolicy = kind === 'source' ? SOURCE_ACTIVE_POLICY : DIST_ACTIVE_POLICY;
  const registeredPolicy = kind === 'source' ? SOURCE_REGISTERED_POLICY : DIST_REGISTERED_POLICY;
  if (count(source, activePolicy) !== 1) {
    throw new Error(`Plan Mode ${kind} policy anchor count ${count(source, activePolicy)}; expected 1`);
  }
  return source.replaceAll(ACTIVE_HELPERS, REGISTERED_HELPERS).replace(activePolicy, registeredPolicy);
}

function patchParsedCommandPolicy(source, returned = 'undefined') {
  const anchor = `if (matchesConfiguredSafeSubcommand(command, safeSubcommands)) return ${returned};`;
  if (count(source, PARSED_POLICY_MARKER) === 2 && count(source, anchor) === 0) return source;
  if (count(source, anchor) !== 2 || count(source, PARSED_POLICY_MARKER) !== 0) {
    throw new Error('Plan Mode command policy anchors are missing or ambiguous');
  }
  // Keep configured Git/GitHub reads behind the existing shell parser and
  // argument validators; a prefix must not authorize a chained mutation.
  return source.replaceAll(anchor, `// ${PARSED_POLICY_MARKER}`);
}

export function patchPiPlanModeDirectory(version, root) {
  if (!SUPPORTED_VERSIONS.includes(version)) {
    throw new Error(`Unsupported Plan Mode version ${version}; expected ${SUPPORTED_VERSIONS.join(' or ')}`);
  }
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (manifest.version !== version) throw new Error('Plan Mode package version does not match requested patch version');

  const paths = [
    { path: join(root, 'src', 'plan-mode.ts'), kind: 'source' },
    { path: join(root, 'dist', 'index.ts'), kind: 'dist' },
  ];
  const patched = paths.map(({ path, kind }) => {
    const source = patchPiPlanModeSource(readFileSync(path, 'utf8'), kind);
    return { path, source };
  });
  if (version === '0.56.0') {
    const path = join(root, 'src', 'tool-policy.ts');
    patched.push({ path, source: patchParsedCommandPolicy(readFileSync(path, 'utf8')) });
    const chunk = join(root, 'dist', 'chunks', 'chunk-57OBPS7P.js');
    patched.push({ path: chunk, source: patchParsedCommandPolicy(readFileSync(chunk, 'utf8'), 'void 0') });
  }
  for (const file of patched) writeFileSync(file.path, file.source);
}

function main(args) {
  if (args.length !== 2) throw new Error('usage: patch-pi-plan-mode-tool-policy.mjs VERSION PACKAGE_ROOT');
  patchPiPlanModeDirectory(args[0], args[1]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
