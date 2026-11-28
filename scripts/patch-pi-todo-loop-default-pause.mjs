#!/usr/bin/env node
// Apply only to the reviewed npm-ci package, before the installed entrypoint is warmed.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const NAME = '@dumbmice/pi-todo-loop';
const VERSION = '0.4.0';
const ENTRYPOINT = './src/index.ts';
const PRISTINE_SHA256 = '981bc66427301ec107ca4c32c3499e62ed2a0038ef17096d4b45a62506c08e4e';
const PRISTINE = '\n\t\t...initialState(),\n\t\tpaused: false,\n';
const PAUSED = '\n\t\t...initialState(),\n\t\tpaused: true,\n';

function patchTodoLoopDefaultPause(root) {
  if (!lstatSync(root).isDirectory() || !lstatSync(join(root, 'src')).isDirectory()) {
    throw new Error('Unsafe Todo Loop package directory');
  }
  const manifestPath = join(root, 'package.json');
  const sourcePath = join(root, ENTRYPOINT);
  if (!lstatSync(manifestPath).isFile() || !lstatSync(sourcePath).isFile()) {
    throw new Error('Unsafe Todo Loop package file');
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.name !== NAME || manifest.version !== VERSION) {
    throw new Error(`Unsupported Todo Loop package; expected ${NAME}@${VERSION}`);
  }
  const entries = manifest.pi?.extensions;
  if (!Array.isArray(entries) || entries.length !== 1 || entries[0] !== ENTRYPOINT) {
    throw new Error('Unsupported Todo Loop extension entrypoint');
  }

  const current = readFileSync(sourcePath, 'utf8');
  const pristine = current.replace(PAUSED, PRISTINE);
  if (createHash('sha256').update(pristine).digest('hex') !== PRISTINE_SHA256
      || pristine.split(PRISTINE).length !== 2) {
    throw new Error('Todo Loop source digest or initialization anchor changed');
  }
  const patched = pristine.replace(PRISTINE, PAUSED);
  if (patched !== current) writeFileSync(sourcePath, patched);
}

try {
  if (process.argv.length !== 3) throw new Error('usage: patch-pi-todo-loop-default-pause.mjs PACKAGE_ROOT');
  patchTodoLoopDefaultPause(process.argv[2]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
