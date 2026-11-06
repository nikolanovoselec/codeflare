#!/usr/bin/env node
// Validates the two lock-backed context-mode installs against the image plugin pin.
// v2 uses cli.mjs/server.mjs and an in-process pi/index.js (no bridge/native addon).
// Retain ESM compatibility and update-probe suppression without rewriting bundled dependencies.
// Implements REQ-AGENT-076 AC5; source compatibility: codeflare#309 / AD49.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// Preserve pristine bytes when upstream already supplies compatibility and no probe.
export const UPSTREAM_SHIM = 'import{createRequire as __cmRequire}from"node:module";if(typeof process.getBuiltinModule!=="function")process.getBuiltinModule=(id)=>__cmRequire(import.meta.url)(id);';
export const SHIM_MARKER = '__ctx_createRequire';
export const SHIM =
  "import { createRequire as __ctx_createRequire } from 'node:module';\n" +
  'var require = __ctx_createRequire(import.meta.url);\n';
export const UPDATE_PROBE_URL = 'https://registry.npmjs.org/context-mode/latest';
export const DISABLED_PROBE_URL = 'https://127.0.0.1:1/context-mode-update-check-disabled';
export const BUNDLE_NAMES = ['cli.mjs', 'server.mjs', 'hook.mjs', 'pi/index.js', 'run.mjs', 'search.mjs'];

export function patchContextModeBundle(content) {
  let out = content;
  const head = out.startsWith('#!') ? out.slice(out.indexOf('\n') + 1) : out;
  if (!out.includes(SHIM_MARKER) && !head.startsWith(UPSTREAM_SHIM)) {
    if (out.startsWith('#!')) {
      const nl = out.indexOf('\n');
      out = nl === -1 ? out + '\n' + SHIM : out.slice(0, nl + 1) + SHIM + out.slice(nl + 1);
    } else {
      out = SHIM + out;
    }
  }
  return out.split(UPDATE_PROBE_URL).join(DISABLED_PROBE_URL);
}

// Missing required v2 entries fail the image build rather than silently skipping Pi.
export function patchContextModeDirectory(dir) {
  for (const name of BUNDLE_NAMES) {
    const file = join(dir, name);
    if (!existsSync(file)) {
      throw new Error(`${file} not found; context-mode layout may have changed`);
    }
    writeFileSync(file, patchContextModeBundle(readFileSync(file, 'utf8')));
    const after = readFileSync(file, 'utf8');
    const head = after.startsWith('#!') ? after.slice(after.indexOf('\n') + 1) : after;
    if (!head.startsWith(SHIM) && !head.startsWith(UPSTREAM_SHIM)) {
      throw new Error(`createRequire shim missing after patch in ${name}`);
    }
    if (after.split(UPDATE_PROBE_URL).length !== 1) {
      throw new Error(`update-check probe still present in ${name} after patch`);
    }
    console.log(`[patch-context-mode] patched ${name} in ${dir} (createRequire shim + update-check disabled)`);
  }
}

function installedVersion(dir) {
  const packageJson = join(dir, 'package.json');
  if (!existsSync(packageJson)) throw new Error(`${packageJson} not found`);
  return JSON.parse(readFileSync(packageJson, 'utf8')).version;
}

export function patchContextModeInstallations(expectedVersion, sharedDirectory, piDirectory) {
  if (!expectedVersion || !sharedDirectory || !piDirectory) {
    throw new Error('expected version, shared directory, and Pi directory are required');
  }
  const sharedVersion = installedVersion(sharedDirectory);
  const piVersion = installedVersion(piDirectory);
  if (sharedVersion !== expectedVersion) {
    throw new Error(`locked context-mode ${sharedVersion ?? 'missing'} != plugin.json ${expectedVersion}`);
  }
  if (piVersion !== expectedVersion) {
    throw new Error(`Pi context-mode ${piVersion ?? 'missing'} != plugin.json ${expectedVersion}`);
  }
  patchContextModeDirectory(sharedDirectory);
  patchContextModeDirectory(piDirectory);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    patchContextModeInstallations(process.argv[2], process.argv[3], process.argv[4]);
  } catch (error) {
    console.error(`[patch-context-mode] FATAL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
