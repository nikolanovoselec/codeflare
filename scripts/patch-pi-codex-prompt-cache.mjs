#!/usr/bin/env node
// Temporary, exact-artifact backport of earendil-works/pi PR #12319 (REQ-AGENT-238).
// Retire this script AND its necessity gates when adopting a fixed upstream release.
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const version = '1.5.2';
const upstreamCommit = 'f7d9657ce20eb6e660d90a46fa235270abd04010';
const receiptName = '.codeflare-codex-prompt-cache-backport.json';
const artifacts = [
  {
    package: '@earendil-works/pi-ai',
    path: 'dist/api/openai-codex-responses.js',
    originalSha256: '4a756bd6c87a6357a811ee512f47d5c3991026bcd213e00a4330be7b0fb4a80d',
    patchedSha256: 'fc011fbb0b1c06c37b0832a0ae3cd0b5c94a0b5bf360248700100ce719726d0c',
    replacements: [
      ['import { getSystemMessageText } from "../utils/text.js";\n', ''],
      ['getDeclaredTools, getInitialSystemMessage, normalizeContext', 'getDeclaredTools, normalizeContext'],
      // Scope to request construction: the separate WS bookkeeping conversion stays unchanged.
      ['const messages = convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, {\n        includeSystemPrompt: false,',
        'const messages = convertResponsesMessages(model, context, CODEX_TOOL_CALL_PROVIDERS, {'],
      ['    const initialSystemMessage = getInitialSystemMessage(context.messages);\n    const instructions = initialSystemMessage ? getSystemMessageText(initialSystemMessage) : "";\n', ''],
      ['        instructions: instructions || "You are a helpful assistant.",\n', ''],
    ],
  },
  {
    package: '@earendil-works/pi-coding-agent',
    path: 'dist/bundle/chunks/openai-codex-responses-TEQRB65N.js',
    originalSha256: '0165f251129fd7a63ada4dc300591458d63fefc30ed9682f7f268ebba5bdbbe9',
    patchedSha256: 'b79e38279b11e67699e4bbbe9c93f3101eabf8eba7dc0f56311e7840c51d3cd5',
    replacements: [
      ['getDeclaredTools,getInitialSystemMessage,normalizeContext', 'getDeclaredTools,normalizeContext'],
      ['getIdentityHeaders,getSystemMessageText', 'getIdentityHeaders'],
      ['{includeSystemPrompt:!1,grammarToolInputProperties,supportsMidConvoSystemMessages:',
        '{grammarToolInputProperties,supportsMidConvoSystemMessages:'],
      ['initialSystemMessage=getInitialSystemMessage(context.messages),instructions=initialSystemMessage?getSystemMessageText(initialSystemMessage):"",body=', 'body='],
      ['instructions:instructions||"You are a helpful assistant.",', ''],
    ],
  },
];
const receipt = {
  schema: 1,
  owner: 'codeflare/pi-codex-prompt-cache',
  upstreamCommit,
  version,
  files: artifacts.map(({ package: name, path, originalSha256, patchedSha256 }) =>
    ({ package: name, path, originalSha256, patchedSha256 })),
};
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(`Codex prompt-cache backport: ${message}`); };

function readRegular(path, optional = false) {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) {
    if (optional && error.code === 'ENOENT') return undefined;
    fail(`artifact drift: cannot read ${path} (${error.code ?? 'unknown error'})`);
  }
  if (!stat.isFile()) fail(`artifact drift: expected regular file at ${path}`);
  return readFileSync(path);
}
function parseManifest(root) {
  try { return JSON.parse(readRegular(join(root, 'package.json')).toString('utf8')); }
  catch (error) { fail(`package manifest drift at ${root}: ${error.message}`); }
}
function dependencyRoot(root) {
  // Resolve npm's nearest installed dependency, including nested installations.
  // Pi's ESM-only exports deliberately do not support require.resolve(packageName).
  const paths = createRequire(join(root, 'package.json')).resolve.paths('@earendil-works/pi-ai');
  for (const path of paths) {
    const candidate = join(path, '@earendil-works/pi-ai');
    try { lstatSync(join(candidate, 'package.json')); return candidate; }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  fail('package drift: cannot resolve @earendil-works/pi-ai');
}
function inspect(piCodingAgentRoot, pristine) {
  const root = resolve(piCodingAgentRoot);
  const ai = dependencyRoot(root);
  const roots = [ai, root];
  const manifests = roots.map(parseManifest);
  const receiptPath = join(root, receiptName);
  const receiptBytes = readRegular(receiptPath, true);
  const staged = artifacts.map((artifact, index) => {
    const path = join(roots[index], artifact.path);
    const original = readRegular(path);
    return { artifact, path, original, digest: hash(original) };
  });
  // A receipt is never evidence of pristine upstream, even if its contents are invalid.
  if (pristine && receiptBytes !== undefined) fail('pristine check rejected a prior receipt; review/remove the obsolete backport');
  if (receiptBytes !== undefined) {
    let parsed;
    try { parsed = JSON.parse(receiptBytes.toString('utf8')); }
    catch { fail('malformed receipt; refusing changes'); }
    if (!isDeepStrictEqual(parsed, receipt)) fail('unknown or incompatible receipt; refusing changes');
  } else {
    // Diagnose an upstream fix before version admission, so a future fixed release is
    // an explicit retirement failure rather than a silently successful no-op.
    const source = staged[0].original.toString('utf8');
    const body = source.slice(source.indexOf('function buildRequestBody('), source.indexOf('\nfunction ', source.indexOf('function buildRequestBody(') + 1));
    if (body.includes('convertResponsesMessages(') && !/\binstructions\s*:/.test(body) && !/\bincludeSystemPrompt\s*:/.test(body)) {
      fail('upstream already fixes prompt placement; remove the obsolete Codex backport and its necessity gates');
    }
  }
  for (let index = 0; index < artifacts.length; index++) {
    if (manifests[index].name !== artifacts[index].package || manifests[index].version !== version) {
      fail(`unsupported package/version drift: requires ${artifacts[index].package}@${version}; review or remove the obsolete backport`);
    }
  }
  for (const entry of staged) {
    const expected = receiptBytes === undefined ? entry.artifact.originalSha256 : entry.artifact.patchedSha256;
    if (entry.digest !== expected) fail(`source hash drift or partial patch: ${entry.artifact.package}/${entry.artifact.path}; refusing changes`);
    if (receiptBytes !== undefined) continue;
    let patched = entry.original.toString('utf8');
    for (const [before, after] of entry.artifact.replacements) {
      if (patched.split(before).length !== 2) fail(`anchor drift: ${entry.artifact.path}`);
      patched = patched.replace(before, after);
    }
    if (hash(patched) !== entry.artifact.patchedSha256) fail(`patched hash drift: ${entry.artifact.path}`);
    entry.patched = patched;
  }
  return { staged, receiptPath, owned: receiptBytes !== undefined };
}

/** Read-only necessity gate. Fixed upstream, drift and every prior receipt are failures. */
export function verifyPiCodexPatchRequired(piCodingAgentRoot) {
  inspect(piCodingAgentRoot, true);
}

/** Apply only to admitted pristine artifacts, or verify an exact owned repeat. */
export function patchPiCodexPromptCache(piCodingAgentRoot) {
  const { staged, receiptPath, owned } = inspect(piCodingAgentRoot, false);
  if (owned) return;
  // All manifests, artifact hashes, replacements and receipt state are validated
  // before the first write. Roll back write failures; a killed process fails closed
  // as an unreceipted/partial patch on the next preparation attempt.
  const written = [];
  let receiptCreated = false;
  try {
    for (const entry of staged) {
      written.push(entry);
      writeFileSync(entry.path, entry.patched);
    }
    const fd = openSync(receiptPath, 'wx', 0o644);
    receiptCreated = true;
    try { writeFileSync(fd, `${JSON.stringify(receipt, null, 2)}\n`); }
    finally { closeSync(fd); }
  } catch (error) {
    if (receiptCreated) unlinkSync(receiptPath);
    for (const entry of written.reverse()) writeFileSync(entry.path, entry.original);
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] === '--check-pristine') verifyPiCodexPatchRequired(args[1]);
  else if (args.length === 1 && !args[0].startsWith('-')) patchPiCodexPromptCache(args[0]);
  else fail('usage: patch-pi-codex-prompt-cache.mjs [--check-pristine] PI_CODING_AGENT_ROOT');
}
