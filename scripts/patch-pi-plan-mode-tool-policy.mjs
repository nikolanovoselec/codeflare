#!/usr/bin/env node
// Applies Codeflare's compatibility patch only to exact reviewed Plan layouts.
// Upstream 0.55 resolves policy from active tools and requires helper tools to
// already be active before /plan starts. Codeflare exposes only five bootstrap
// tools to ordinary provider turns, so the image patch resolves Plan policy from
// registered tools while the late exposure finalizer activates only the frozen
// Plan policy and helper tools for Plan turns.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const EXPECTED_PI_PLAN_MODE_VERSION = '0.55.3';
const SUPPORTED_VERSIONS = [EXPECTED_PI_PLAN_MODE_VERSION, '0.56.0', '0.58.3', '0.59.2', '0.59.4', '0.59.6', '0.60.0', '0.60.1', '0.60.3'];
// Integrity-verified 0.59.4 source profile; native custom-turn boundary is
// already correct (and covered behaviorally), so do not patch it a second time.
const REVIEWED_0594 = {
  'src/plan-mode.ts': '276c1b2981d7df2dccbe1e276f8c8d53d84006d66235f7a5682646535d32787a',
  'dist/index.ts': '2ea9150cc6615ce7d5dffbca1c9f7f305c140d2935da0ee3c62a7932072ddd69',
  'src/tool-policy.ts': '5f807c5c9c21afa9bd15b4a028828c33a6c3c4109fd90965d55590bde7ff6a19',
  'dist/chunks/chunk-MJV6WNHK.ts': '9f9f0b598741d2d7da001fb1912d12d658e48dd21e68cd3743a213a07b810548',
};
// Registry-integrity verified 0.59.6; src matches upstream commit
// 980db40db9b1db3b8dc92b2b1837eb06841bfea2. Native custom-turn boundary
// and parsed policy are unchanged; passive settings timers now unref.
const REVIEWED_0596 = {
  'src/plan-mode.ts': '30a2c82f7c0a42ad7d236ae1b016981a915a04f16e0cb768ccb2f1c729d327ff',
  'dist/index.ts': '53b75847606f5d96b93bf90183045a2078b986213ffcf1e6fe445beba2f20f1f',
  'src/tool-policy.ts': '5f807c5c9c21afa9bd15b4a028828c33a6c3c4109fd90965d55590bde7ff6a19',
  'dist/chunks/chunk-W7D6N2MI.ts': 'eef51fcdc9bd25a8cf64bfaf8a13e3011fb2aa0fb936f388fad2f167794abe8c'
};
// Registry SHA-512 verified 0.60.0. Tool policy and the native custom-turn
// guard are unchanged; retain the latter rather than applying it twice.
const REVIEWED_0600 = {
  'src/plan-mode.ts': '0b354ec401d4a4fe2187f3ac34faef5253af9a55aad43e626a3108a15b1f4d48',
  'dist/index.ts': '07300080f4e30fe6fad67ac9459c97688c9cdb1406fd785be1430a9de6face1e',
  'src/tool-policy.ts': '5f807c5c9c21afa9bd15b4a028828c33a6c3c4109fd90965d55590bde7ff6a19',
  'dist/chunks/chunk-UJ6TV2YV.ts': 'f75131129361b4bd47686d61792b1853a18282e1b19fd0266a328601fee1cfed',
};
// Registry SHA-512 verified 0.60.1; src matches upstream commit
// 935080628841bb143faca9d5d9f436887a3d15c0. Only session-local widget
// disclosure/presentation changes; parsed policy and custom-turn guard are retained.
const REVIEWED_0601 = {
  'src/plan-mode.ts': '0b32574f90df02d7950abeff6eaff3804e65d97fbb15311fad0684cca9c6994e',
  'dist/index.ts': 'b77ab5ced4431ebd64fcf2595550b65bea57cab70c2d5a8f094043c9e3a4e6b9',
  'src/tool-policy.ts': '5f807c5c9c21afa9bd15b4a028828c33a6c3c4109fd90965d55590bde7ff6a19',
  'dist/chunks/chunk-UJ6TV2YV.ts': 'f75131129361b4bd47686d61792b1853a18282e1b19fd0266a328601fee1cfed',
};
// Registry SHA-512 verified 0.60.3; preserves the native custom-turn guard.
const REVIEWED_0603 = {
  'src/plan-mode.ts': 'b9f6112637cec17fa0af96753f406c369490e229e8f2be4dabd26e7a844bc4dc',
  'dist/index.ts': '385a191f9186f8a9ccc11518bad1a0efdf2df4011bbf7252a8fae29af8819e2c',
  'src/tool-policy.ts': REVIEWED_0601['src/tool-policy.ts'],
  'dist/chunks/chunk-OB2K6QCX.ts': '7549be4ea3dc6c84d1706a5fe1c3cfb6df9f5bea741fdd63a2aeec3f5222e8b5',
};
function validateReviewedSources(root, profile) {
  for (const [path, expected] of Object.entries(profile)) {
    const info = lstatSync(join(root, path));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Unsafe Plan Mode source path: ${path}`);
    let source = readFileSync(join(root, path), 'utf8');
    // Reverse only our exact owned edits before checking the full pristine identity.
    source = source.replaceAll(REGISTERED_HELPERS, ACTIVE_HELPERS)
      .replace(REGISTERED_AVAILABLE_POLICY, AVAILABLE_POLICY)
      .replaceAll(`// ${PARSED_POLICY_MARKER}`, 'if (matchesConfiguredSafeSubcommand(segment, safeSubcommands)) return true;')
      .replaceAll(VERSION_ONLY_QUERY, VERSION_QUERY);
    if (createHash('sha256').update(source).digest('hex') !== expected) {
      throw new Error(`Plan Mode source digest changed: ${path}`);
    }
  }
}
const VERSION_QUERY = 'if (args.includes("--version")) return true;';
const VERSION_ONLY_QUERY = 'if (args.length === 1 && args[0] === "--version") return true; // CODEFLARE_PLAN_VERSION_ONLY';
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
  const activePolicy = (version === '0.59.2' || version === '0.59.4' || version === '0.59.6' || version === '0.60.0' || version === '0.60.1' || version === '0.60.3') ? AVAILABLE_POLICY : usesTabs ? SOURCE_ACTIVE_POLICY : DIST_ACTIVE_POLICY;
  const registeredPolicy = (version === '0.59.2' || version === '0.59.4' || version === '0.59.6' || version === '0.60.0' || version === '0.60.1' || version === '0.60.3') ? REGISTERED_AVAILABLE_POLICY : usesTabs ? SOURCE_REGISTERED_POLICY : DIST_REGISTERED_POLICY;
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

function patchVersionOnlyQueries(source) {
  if (count(source, VERSION_ONLY_QUERY) === 1 && count(source, VERSION_QUERY) === 0) return source;
  if (count(source, VERSION_QUERY) !== 1 || source.includes('CODEFLARE_PLAN_VERSION_ONLY')) {
    throw new Error('Plan Mode version-query policy anchor is missing or ambiguous');
  }
  return source.replace(VERSION_QUERY, VERSION_ONLY_QUERY);
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
  if (version === '0.59.6' || version === '0.60.0' || version === '0.60.1' || version === '0.60.3') {
    const info = lstatSync(join(root, 'package.json'));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Unsafe Plan Mode package manifest');
  }
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (manifest.version !== version) throw new Error('Plan Mode package version does not match requested patch version');
  if ((version === '0.59.6' || version === '0.60.0' || version === '0.60.1' || version === '0.60.3') && (!Array.isArray(manifest.pi?.extensions)
    || manifest.pi.extensions.length !== 1 || manifest.pi.extensions[0] !== './dist/index.ts')) {
    throw new Error('Plan Mode declares an unsupported Pi extension entrypoint');
  }

  if (version === '0.59.4' || version === '0.59.6' || version === '0.60.0' || version === '0.60.1' || version === '0.60.3') {
    if (manifest.name !== '@narumitw/pi-plan-mode') throw new Error('Plan Mode package identity mismatch');
    validateReviewedSources(root, version === '0.60.3' ? REVIEWED_0603 : version === '0.60.1' ? REVIEWED_0601 : version === '0.60.0' ? REVIEWED_0600 : version === '0.59.6' ? REVIEWED_0596 : REVIEWED_0594);
  }
  const paths = [
    { path: join(root, 'src', 'plan-mode.ts'), kind: 'source' },
    { path: join(root, 'dist', 'index.ts'), kind: 'dist' },
  ];
  const patched = paths.map(({ path, kind }) => {
    const source = patchPiPlanModeSource(readFileSync(path, 'utf8'), kind, version);
    return { path, source: version === '0.59.2' ? patchUserPromptBoundary(source, kind) : source };
  });
  if (version === '0.56.0' || version === '0.58.3' || version === '0.59.2' || version === '0.59.4' || version === '0.59.6' || version === '0.60.0' || version === '0.60.1' || version === '0.60.3') {
    const current = version === '0.59.2' || version === '0.59.4' || version === '0.59.6' || version === '0.60.0' || version === '0.60.1' || version === '0.60.3';
    const path = join(root, 'src', 'tool-policy.ts');
    const versionOnly = ['0.59.4', '0.59.6', '0.60.0', '0.60.1', '0.60.3'].includes(version);
    const preparePolicy = (source, returned) => {
      const parsed = patchParsedCommandPolicy(source, returned, current ? 'segment' : 'command');
      return versionOnly ? patchVersionOnlyQueries(parsed) : parsed;
    };
    patched.push({ path, source: preparePolicy(readFileSync(path, 'utf8'), current ? 'true' : 'undefined') });
    const chunk = join(root, 'dist', 'chunks', version === '0.60.3' ? 'chunk-OB2K6QCX.ts' : (version === '0.60.0' || version === '0.60.1') ? 'chunk-UJ6TV2YV.ts' : version === '0.59.6' ? 'chunk-W7D6N2MI.ts' : current ? 'chunk-MJV6WNHK.ts' : version === '0.58.3' ? 'chunk-L2CXUWCH.ts' : 'chunk-57OBPS7P.js');
    patched.push({ path: chunk, source: preparePolicy(readFileSync(chunk, 'utf8'), current ? 'true' : 'void 0') });
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
