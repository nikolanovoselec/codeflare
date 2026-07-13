#!/usr/bin/env node

import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const EXPECTED_VERSION = '1.20.0';
const PAYLOAD_ROOT = dirname(fileURLToPath(import.meta.url));
const FILES = ['index.ts', 'todo.ts', 'todo-overlay.ts', 'state/store.ts'];

export function installRpivTodoSessionIsolation(npmRoot = process.cwd(), payloadRoot = PAYLOAD_ROOT) {
  const packageRoot = join(npmRoot, 'node_modules/@juicesharp/rpiv-todo');
  const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'));
  if (packageJson.version !== EXPECTED_VERSION) {
    throw new Error(
      `expected @juicesharp/rpiv-todo ${EXPECTED_VERSION}, found ${String(packageJson.version)}; review or remove the session-isolation override`,
    );
  }

  for (const relativePath of FILES) {
    const destination = join(packageRoot, relativePath);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(payloadRoot, relativePath), destination);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  try {
    installRpivTodoSessionIsolation();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
