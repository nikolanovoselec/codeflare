#!/usr/bin/env node
import { constants } from 'node:fs';
import { access, readFile, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, extname, join, parse, relative, resolve } from 'node:path';
import { spawn } from 'node:child_process';

const DEFAULT_TIMEOUT_MS = 180_000;
const ANALYZERS = new Set(['oxlint', 'eslint', 'biome', 'prettier']);
const FORBIDDEN_ARGUMENTS = [
  /^--fix(?:$|=|-)/u,
  /^--write(?:$|=)/u,
  /^--apply(?:$|=|-)/u,
  /^--watch(?:$|=)/u,
  /^--output-file(?:$|=)/u,
  /^-o(?:$|=|[^-])/u,
  /^--cache(?:$|=|-)/u,
  /^--cache-location(?:$|=)/u,
  /^--concurrency(?:$|=)/u,
  /^--init$/u,
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
    '  safe-local-check.mjs ts-syntax <file...>',
    '  safe-local-check.mjs json <file...>',
    '  safe-local-check.mjs yaml <file...>',
    '  safe-local-check.mjs shell-syntax <file...>',
    '  safe-local-check.mjs lock-consistency [package-lock.json...]',
    '  safe-local-check.mjs pi-preseed',
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

async function readable(path) {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function repositoryRoot(cwd) {
  const start = resolve(cwd);
  const filesystemRoot = parse(start).root;
  let directory = start;
  while (true) {
    try {
      await access(join(directory, '.git'), constants.F_OK);
      return directory;
    } catch { /* keep looking for the enclosing repository */ }
    if (directory === filesystemRoot) return start;
    directory = dirname(directory);
  }
}

async function repositoryBinary(name, cwd) {
  let directory = resolve(cwd);
  const boundary = await repositoryRoot(directory);
  while (true) {
    const candidate = join(directory, 'node_modules', '.bin', name);
    if (await executable(candidate)) return candidate;
    if (directory === boundary) return undefined;
    directory = dirname(directory);
  }
}

async function repositoryRequire(cwd, packageName) {
  const root = await realpath(await repositoryRoot(cwd));
  try {
    const require = createRequire(join(root, 'package.json'));
    const resolved = await realpath(require.resolve(packageName));
    const rel = relative(join(root, 'node_modules'), resolved);
    if (rel.startsWith('..') || rel === '' || parse(rel).root) throw new Error('outside repository');
    return require(resolved);
  } catch {
    throw new Error(`repository-local ${packageName} is not installed`);
  }
}

async function repositoryFiles(args, mode) {
  if (args.length === 0) throw new Error(`${mode} requires at least one file`);
  const root = await realpath(await repositoryRoot(process.cwd()));
  const files = [];
  for (const file of args) {
    const path = resolve(process.cwd(), file);
    if (!(await readable(path))) throw new Error(`${file} is not readable`);
    const resolvedPath = await realpath(path);
    const rel = relative(root, resolvedPath);
    if (rel.startsWith('..') || rel === '' || parse(rel).root) {
      throw new Error(`${file} is outside repository ${root}`);
    }
    files.push(resolvedPath);
  }
  return { root, files };
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

async function parseJsonFile(file) {
  try {
    JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function checkJson(args) {
  const { files } = await repositoryFiles(args, 'json');
  for (const file of files) await parseJsonFile(file);
  return 0;
}

async function checkYaml(args) {
  const { files } = await repositoryFiles(args, 'yaml');
  const yaml = await repositoryRequire(process.cwd(), 'yaml');
  for (const file of files) {
    const doc = yaml.parseDocument(await readFile(file, 'utf8'));
    if (doc.errors?.length) throw new Error(`${file}: ${doc.errors[0].message}`);
  }
  return 0;
}

async function checkTsSyntax(args) {
  const { files } = await repositoryFiles(args, 'ts-syntax');
  const esbuild = await repositoryRequire(process.cwd(), 'esbuild');
  for (const file of files) {
    const extension = extname(file).toLowerCase();
    const loader = extension === '.tsx' ? 'tsx' : extension === '.jsx' ? 'jsx' : extension === '.json' ? 'json' : extension === '.js' || extension === '.mjs' || extension === '.cjs' ? 'js' : 'ts';
    try {
      await esbuild.transform(await readFile(file, 'utf8'), { loader, logLevel: 'silent' });
    } catch (error) {
      throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return 0;
}

async function checkShellSyntax(args) {
  const { files } = await repositoryFiles(args, 'shell-syntax');
  const deadline = Date.now() + managedTimeout();
  for (const file of files) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return 124;
    const code = await runBounded('/usr/bin/bash', ['-n', file], remaining);
    if (code !== 0) return code;
  }
  return 0;
}

function dependencyMaps(manifest) {
  return Object.assign(
    {},
    manifest.optionalDependencies ?? {},
    manifest.peerDependencies ?? {},
    manifest.devDependencies ?? {},
    manifest.dependencies ?? {},
  );
}

function packageEntryName(name) {
  return `node_modules/${name}`;
}

function expectedTarballSegment(name, version) {
  return `/-/${name.split('/').pop()}-${version}.tgz`;
}

async function checkLockFile(lockPath) {
  const lock = JSON.parse(await readFile(lockPath, 'utf8'));
  if (lock.lockfileVersion !== 3 || !lock.packages || typeof lock.packages !== 'object') {
    throw new Error(`${lockPath}: expected npm lockfileVersion 3 with packages`);
  }
  const packagePath = join(dirname(lockPath), 'package.json');
  const manifest = JSON.parse(await readFile(packagePath, 'utf8'));
  const manifestDeps = dependencyMaps(manifest);
  const lockDeps = dependencyMaps(lock.packages[''] ?? {});
  for (const name of Object.keys(lockDeps)) {
    if (!(name in manifestDeps)) throw new Error(`${lockPath}: extra root dependency ${name}`);
  }
  for (const [name, spec] of Object.entries(manifestDeps)) {
    if (lockDeps[name] !== spec) throw new Error(`${lockPath}: root dependency ${name} mismatch`);
    if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(spec)) continue;
    const entry = lock.packages[packageEntryName(name)];
    if (!entry) throw new Error(`${lockPath}: missing ${name} package entry`);
    if (entry.version !== spec) throw new Error(`${lockPath}: ${name} entry version ${entry.version} != ${spec}`);
    if (typeof entry.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(entry.integrity)) {
      throw new Error(`${lockPath}: ${name} missing sha512 integrity`);
    }
    if (typeof entry.resolved === 'string' && !entry.resolved.includes(expectedTarballSegment(name, spec))) {
      throw new Error(`${lockPath}: ${name} resolved URL does not match ${spec}`);
    }
  }
}

async function checkLockConsistency(args) {
  const paths = args.length > 0 ? args : ['package-lock.json'];
  const { files } = await repositoryFiles(paths, 'lock-consistency');
  for (const file of files) await checkLockFile(file);
  return 0;
}

async function checkPiPreseed() {
  const root = await repositoryRoot(process.cwd());
  const packagePath = join(root, 'preseed/agents/pi/package.json');
  const lockPath = join(root, 'preseed/agents/pi/package-lock.json');
  const entrypointPath = join(root, 'entrypoint.sh');
  const seedPath = join(root, 'src/lib/agent-seed.generated.ts');
  for (const path of [packagePath, lockPath, entrypointPath, seedPath]) {
    if (!(await readable(path))) throw new Error(`${path} is not readable`);
  }
  await checkLockFile(lockPath);
  const manifest = JSON.parse(await readFile(packagePath, 'utf8'));
  const entrypoint = await readFile(entrypointPath, 'utf8');
  for (const [name, version] of Object.entries(manifest.dependencies ?? {})) {
    if (name === '@earendil-works/pi-coding-agent') continue;
    const spec = `npm:${name}@${version}`;
    if (!entrypoint.includes(`'${spec}'`)) throw new Error(`entrypoint.sh missing ${spec}`);
  }
  const seed = await readFile(seedPath, 'utf8');
  const packageJson = `${JSON.stringify(manifest, null, 2)}\n`;
  if (!seed.includes(JSON.stringify(packageJson))) throw new Error('generated agent seed does not embed preseed/agents/pi/package.json');
  return 0;
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
  if (mode === 'json') return checkJson(args);
  if (mode === 'yaml') return checkYaml(args);
  if (mode === 'ts-syntax') return checkTsSyntax(args);
  if (mode === 'shell-syntax') return checkShellSyntax(args);
  if (mode === 'lock-consistency') return checkLockConsistency(args);
  if (mode === 'pi-preseed') return checkPiPreseed();
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
