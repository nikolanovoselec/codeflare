#!/usr/bin/env node

import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { strictSemverUpgrade } from './semver-forward.mjs';

const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;

export function updateCodeServerPins(source, pins) {
  const {
    codeServerVersion,
    codeServerCommit,
    codeVersion,
    vscodeCommit,
    jsYamlVersion,
    ideTarVersion,
  } = pins;
  if (!VERSION_PATTERN.test(codeServerVersion) || !VERSION_PATTERN.test(codeVersion)) {
    throw new Error('code-server and embedded Code versions must be valid release versions');
  }
  if (!COMMIT_PATTERN.test(codeServerCommit) || !COMMIT_PATTERN.test(vscodeCommit)) {
    throw new Error('code-server and VS Code commits must be lowercase 40-character SHAs');
  }

  for (const [name, version, major] of [
    ['CODE_SERVER_JS_YAML_VERSION', jsYamlVersion, '5'],
    ['CODE_SERVER_IDE_TAR_VERSION', ideTarVersion, '7'],
  ]) {
    const current = [...source.matchAll(new RegExp(`${name}="([^"]+)"`, 'g'))];
    if (current.length !== 1) throw new Error(`expected exactly one Dockerfile match for ${name}`);
    if (!/^\d+\.\d+\.\d+$/.test(version ?? '') || version.split('.')[0] !== major) {
      throw new Error(`${name} requires a qualified ${major}.x bundled release`);
    }
    if (version !== current[0][1] && !strictSemverUpgrade(current[0][1], version)) {
      throw new Error(`${name} must not downgrade the bundled security version`);
    }
  }

  const replacements = [
    [/CODE_SERVER_VERSION="[^"]+"/, `CODE_SERVER_VERSION="${codeServerVersion}"`],
    [/CODE_SERVER_SHA256="[^"]+"/, 'CODE_SERVER_SHA256="NEEDS_UPDATE_SEE_PR_BODY"'],
    [/CODE_SERVER_COMMIT="[^"]+"/, `CODE_SERVER_COMMIT="${codeServerCommit}"`],
    [/CODE_SERVER_CODE_VERSION="[^"]+"/, `CODE_SERVER_CODE_VERSION="${codeVersion}"`],
    [/CODE_SERVER_VSCODE_COMMIT="[^"]+"/, `CODE_SERVER_VSCODE_COMMIT="${vscodeCommit}"`],
    [/CODE_SERVER_JS_YAML_VERSION="[^"]+"/, `CODE_SERVER_JS_YAML_VERSION="${jsYamlVersion}"`],
    [/CODE_SERVER_IDE_TAR_VERSION="[^"]+"/, `CODE_SERVER_IDE_TAR_VERSION="${ideTarVersion}"`],
  ];

  return replacements.reduce((content, [pattern, replacement]) => {
    const matches = content.match(new RegExp(pattern.source, 'g')) ?? [];
    if (matches.length !== 1) {
      throw new Error(`expected exactly one Dockerfile match for ${pattern.source}`);
    }
    return content.replace(pattern, replacement);
  }, source);
}

async function main() {
  const path = process.argv[2] ?? 'Dockerfile';
  const source = await readFile(path, 'utf8');
  const updated = updateCodeServerPins(source, {
    codeServerVersion: process.env.CODE_SERVER_VERSION ?? '',
    codeServerCommit: process.env.CODE_SERVER_COMMIT ?? '',
    codeVersion: process.env.CODE_SERVER_CODE_VERSION ?? '',
    vscodeCommit: process.env.CODE_SERVER_VSCODE_COMMIT ?? '',
    jsYamlVersion: process.env.CODE_SERVER_JS_YAML_VERSION ?? '',
    ideTarVersion: process.env.CODE_SERVER_IDE_TAR_VERSION ?? '',
  });
  await writeFile(path, updated);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
