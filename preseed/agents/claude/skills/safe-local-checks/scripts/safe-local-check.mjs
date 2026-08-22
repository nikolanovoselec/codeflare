#!/usr/bin/env node
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { dirname, join, parse, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 180_000;
const ANALYZERS = new Set(['oxlint', 'eslint', 'biome', 'prettier']);
const FORBIDDEN_ARGUMENTS = [
  /^--fix(?:$|=|-)/u,
  /^--write(?:$|=)/u,
  /^--apply(?:$|=|-)/u,
  /^--watch(?:$|=)/u,
  /^--output-file(?:$|=)/u,
  /^--concurrency(?:$|=)/u,
  /^-w$/u,
];

function fail(message) {
  process.stderr.write(`safe-local-check: ${message}\n`);
  process.exitCode = 2;
}

function usage() {
  return [
    'Usage:',
    '  safe-local-check.mjs oxlint [arguments...]',
    '  safe-local-check.mjs eslint [arguments...]',
    '  safe-local-check.mjs biome check [arguments...]',
    '  safe-local-check.mjs prettier --check [arguments...]',
    '  safe-local-check.mjs syntax <file...>',
  ].join('\n');
}

function managedTimeout() {
  const requested = Number(process.env.SAFE_LOCAL_CHECK_TIMEOUT_MS);
  return Number.isFinite(requested) && requested > 0
    ? Math.min(requested, DEFAULT_TIMEOUT_MS)
    : DEFAULT_TIMEOUT_MS;
}

async function executable(path) {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function repositoryBinary(name, cwd) {
  let directory = resolve(cwd);
  const root = parse(directory).root;
  while (true) {
    const candidate = join(directory, 'node_modules', '.bin', name);
    if (await executable(candidate)) return candidate;
    if (directory === root) return undefined;
    directory = dirname(directory);
  }
}

function validateReadOnly(mode, args) {
  const forbidden = args.find((argument) => FORBIDDEN_ARGUMENTS.some((pattern) => pattern.test(argument)));
  if (forbidden) throw new Error(`${forbidden} is not allowed; managed local checks are read-only`);
  if (mode === 'biome' && args[0] !== 'check') {
    throw new Error('Biome is limited to the read-only `check` command');
  }
  if (mode === 'prettier' && !args.some((argument) => argument === '--check' || argument === '-c')) {
    throw new Error('Prettier requires --check');
  }
}

function runBounded(executablePath, args, timeoutMs) {
  return new Promise((resolveExit, reject) => {
    const child = spawn('/usr/bin/nice', ['-n', '10', executablePath, ...args], {
      cwd: process.cwd(),
      detached: true,
      env: { ...process.env, CI: '1', NO_COLOR: '1' },
      stdio: 'inherit',
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid, 'SIGTERM'); } catch { /* already exited */ }
      setTimeout(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already exited */ }
      }, 250).unref();
    }, timeoutMs);
    timer.unref();
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        process.stderr.write(`safe-local-check: stopped after ${timeoutMs}ms\n`);
        resolveExit(124);
        return;
      }
      if (signal) {
        process.stderr.write(`safe-local-check: analyzer stopped by ${signal}\n`);
        resolveExit(1);
        return;
      }
      resolveExit(code ?? 1);
    });
  });
}

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (!mode || mode === '--help' || mode === '-h') {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  if (mode === 'syntax') {
    if (args.length === 0) throw new Error('syntax requires at least one file');
    const deadline = Date.now() + managedTimeout();
    for (const file of args) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return 124;
      const code = await runBounded(process.execPath, ['--check', file], remaining);
      if (code !== 0) return code;
    }
    return 0;
  }
  if (!ANALYZERS.has(mode)) throw new Error(`unsupported analyzer ${JSON.stringify(mode)}`);
  validateReadOnly(mode, args);
  const binary = await repositoryBinary(mode, process.cwd());
  if (!binary) throw new Error(`repository-local ${mode} is not installed`);
  return runBounded(binary, args, managedTimeout());
}

try {
  const code = await main();
  process.exitCode = code;
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
