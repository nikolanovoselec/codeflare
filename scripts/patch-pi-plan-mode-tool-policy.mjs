#!/usr/bin/env node
// Applies Codeflare's compatibility patch only to exact reviewed Plan layouts.
// Upstream 0.55 resolves policy from active tools and requires helper tools to
// already be active before /plan starts. Codeflare exposes only five bootstrap
// tools to ordinary provider turns, so the image patch resolves Plan policy from
// registered tools while the late exposure finalizer activates only the frozen
// Plan policy and helper tools for Plan turns.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const EXPECTED_PI_PLAN_MODE_VERSION = '0.55.3';
const SUPPORTED_VERSIONS = [EXPECTED_PI_PLAN_MODE_VERSION, '0.56.0', '0.58.3', '0.59.2'];
const PARSED_POLICY_MARKER = 'CODEFLARE_PLAN_PARSED_COMMAND_POLICY';
const USER_PROMPT_MARKER = 'CODEFLARE_PLAN_USER_PROMPT_BOUNDARY';
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

const AVAILABLE_POLICY = `  function availablePlanPolicyTools() {
    const activeNames = new Set(safeGetActiveTools());
    return selectableTools().filter((tool) => planModeToolAvailability(tool, activeNames) === "available");
  }`;
const REGISTERED_AVAILABLE_POLICY = `  function availablePlanPolicyTools() {
    return selectableTools(); // CODEFLARE_PLAN_REGISTERED_POLICY
  }`;

function count(source, value) {
  return source.split(value).length - 1;
}

export function patchPiPlanModeSource(source, kind, version) {
  if (source.includes(REGISTERED_HELPERS_MARKER) || source.includes(REGISTERED_POLICY_MARKER)) {
    if (count(source, REGISTERED_HELPERS_MARKER) !== 2 || count(source, REGISTERED_POLICY_MARKER) !== 1) {
      throw new Error(`Plan Mode ${kind} contains an incomplete Codeflare compatibility patch`);
    }
    return source;
  }
  if (count(source, ACTIVE_HELPERS) !== 2) {
    throw new Error(`Plan Mode ${kind} helper anchor count ${count(source, ACTIVE_HELPERS)}; expected 2`);
  }
  const usesTabs = kind === 'source' && source.includes(SOURCE_ACTIVE_POLICY);
  const activePolicy = version === '0.59.2' ? AVAILABLE_POLICY : usesTabs ? SOURCE_ACTIVE_POLICY : DIST_ACTIVE_POLICY;
  const registeredPolicy = version === '0.59.2' ? REGISTERED_AVAILABLE_POLICY : usesTabs ? SOURCE_REGISTERED_POLICY : DIST_REGISTERED_POLICY;
  if (count(source, activePolicy) !== 1) {
    throw new Error(`Plan Mode ${kind} policy anchor count ${count(source, activePolicy)}; expected 1`);
  }
  return source.replaceAll(ACTIVE_HELPERS, REGISTERED_HELPERS).replace(activePolicy, registeredPolicy);
}

function patchParsedCommandPolicy(source, returned = 'undefined', argument = 'command') {
  const anchor = `if (matchesConfiguredSafeSubcommand(${argument}, safeSubcommands)) return ${returned};`;
  if (count(source, PARSED_POLICY_MARKER) === 2 && count(source, anchor) === 0) return source;
  if (count(source, anchor) !== 2 || count(source, PARSED_POLICY_MARKER) !== 0) {
    throw new Error('Plan Mode command policy anchors are missing or ambiguous');
  }
  // Keep configured Git/GitHub reads behind the existing shell parser and
  // argument validators; a prefix must not authorize a chained mutation.
  return source.replaceAll(anchor, `// ${PARSED_POLICY_MARKER}`);
}

function patchUserPromptBoundary(source, kind) {
  const anchor = `  pi.on("before_agent_start", (_event, ctx) => {
    refreshStateForFirstPrompt(ctx);
    if (!state.enabled || !workflowMutex.isOwner(workflowOwner)) return;
    if (state.latestPlan || state.awaitingAction) {`;
  const patched = anchor.replace('if (state.latestPlan || state.awaitingAction) {',
    `if (_event.messageType !== "custom" && (state.latestPlan || state.awaitingAction)) { // ${USER_PROMPT_MARKER}`);
  if (count(source, USER_PROMPT_MARKER) === 1 && count(source, patched) === 1) return source;
  if (count(source, USER_PROMPT_MARKER) !== 0 || count(source, anchor) !== 1) {
    throw new Error(`Plan Mode ${kind} user-prompt boundary anchor is missing or ambiguous`);
  }
  // Custom notification turns still refresh runtime state, but are not new user intent.
  return source.replace(anchor, patched);
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
    const source = patchPiPlanModeSource(readFileSync(path, 'utf8'), kind, version);
    return { path, source: version === '0.59.2' ? patchUserPromptBoundary(source, kind) : source };
  });
  if (version === '0.56.0' || version === '0.58.3' || version === '0.59.2') {
    const current = version === '0.59.2';
    const path = join(root, 'src', 'tool-policy.ts');
    patched.push({ path, source: patchParsedCommandPolicy(readFileSync(path, 'utf8'), current ? 'true' : 'undefined', current ? 'segment' : 'command') });
    const chunk = join(root, 'dist', 'chunks', current ? 'chunk-MJV6WNHK.ts' : version === '0.58.3' ? 'chunk-L2CXUWCH.ts' : 'chunk-57OBPS7P.js');
    patched.push({ path: chunk, source: patchParsedCommandPolicy(readFileSync(chunk, 'utf8'), current ? 'true' : 'void 0', current ? 'segment' : 'command') });
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
