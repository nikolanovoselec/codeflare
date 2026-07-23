import { randomUUID } from 'node:crypto';
import {
  chmod,
  cp,
  lstat,
  link,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

import officialClaude from '../official-claude.json' with { type: 'json' };

export const OFFICIAL_CLAUDE_EXTENSION = Object.freeze({
  directoryName: `${officialClaude.namespace.toLowerCase()}.${officialClaude.name}`,
  name: officialClaude.name,
  publisher: officialClaude.namespace,
  version: officialClaude.version,
  main: officialClaude.main,
  vscodeEngine: officialClaude.vscodeEngine,
});

export interface StageSidebarExtensionOptions {
  readonly sourceDirectory: string;
  readonly claudeSourceDirectory: string;
  readonly rootDirectory: string;
}

export interface StagedSidebarExtension {
  readonly sharedExtension: string;
  readonly inventories: Readonly<{
    pi: string;
    claude: string;
    none: string;
  }>;
}

export async function stageSidebarExtension(
  options: StageSidebarExtensionOptions,
): Promise<StagedSidebarExtension> {
  const sourceDirectory = absoluteDirectory(options.sourceDirectory, 'source');
  const claudeSourceDirectory = absoluteDirectory(options.claudeSourceDirectory, 'official Claude source');
  const rootDirectory = absoluteDirectory(options.rootDirectory, 'root');
  if (
    !separatePaths(sourceDirectory, rootDirectory) ||
    !separatePaths(claudeSourceDirectory, rootDirectory) ||
    !separatePaths(sourceDirectory, claudeSourceDirectory)
  ) {
    throw new Error('Extension sources and staging root must be separate');
  }
  await validateOwnedSource(sourceDirectory);
  await validateOfficialClaudeSource(claudeSourceDirectory);

  const stageRoot = join(dirname(rootDirectory), `.${basename(rootDirectory)}.stage-${randomUUID()}`);
  const sharedExtension = join(stageRoot, 'extension');
  const inventoriesRoot = join(stageRoot, 'extensions');
  const inventories = {
    pi: join(inventoriesRoot, 'pi'),
    claude: join(inventoriesRoot, 'claude'),
    none: join(inventoriesRoot, 'none'),
  } as const;

  try {
    await rm(stageRoot, { recursive: true, force: true });
    await mkdir(dirname(stageRoot), { recursive: true, mode: 0o755 });
    await cp(sourceDirectory, sharedExtension, {
      recursive: true,
      force: false,
      errorOnExist: true,
      preserveTimestamps: true,
    });
    await Promise.all(Object.values(inventories).map((directory) => mkdir(directory, { recursive: true, mode: 0o755 })));
    await hardlinkTree(sharedExtension, join(inventories.pi, 'codeflare-agent-sidebar'));
    await hardlinkTree(
      claudeSourceDirectory,
      join(inventories.claude, OFFICIAL_CLAUDE_EXTENSION.directoryName),
    );
    await writeFile(
      join(stageRoot, 'official-claude.json'),
      `${JSON.stringify(officialClaude, null, 2)}\n`,
      { encoding: 'utf8', mode: 0o444 },
    );
    await makeImmutable(stageRoot);
    await rm(rootDirectory, { recursive: true, force: true });
    await rename(stageRoot, rootDirectory);
  } catch (error) {
    await rm(stageRoot, { recursive: true, force: true });
    throw error;
  }

  return Object.freeze({
    sharedExtension: join(rootDirectory, 'extension'),
    inventories: Object.freeze({
      pi: join(rootDirectory, 'extensions', 'pi'),
      claude: join(rootDirectory, 'extensions', 'claude'),
      none: join(rootDirectory, 'extensions', 'none'),
    }),
  });
}

async function validateOwnedSource(sourceDirectory: string): Promise<void> {
  const source = await lstat(sourceDirectory);
  if (!source.isDirectory() || source.isSymbolicLink()) throw new Error('Extension source must be a real directory');
  const packagePath = join(sourceDirectory, 'package.json');
  const packageStat = await lstat(packagePath);
  if (!packageStat.isFile() || packageStat.size > 256 * 1024) throw new Error('Invalid owned extension package');
  const manifest = JSON.parse(await readFile(packagePath, 'utf8')) as Record<string, unknown>;
  if (manifest.name !== 'codeflare-agent-sidebar' || manifest.publisher !== 'codeflare') {
    throw new Error('Extension publisher is not Codeflare-owned');
  }
  const mainPath = typeof manifest.main === 'string' ? manifest.main.replace(/^\.\//, '') : '';
  if (!mainPath.startsWith('dist/') || mainPath.includes('..')) {
    throw new Error('Invalid owned extension entry point');
  }
  const main = await lstat(join(sourceDirectory, mainPath));
  if (!main.isFile() || main.isSymbolicLink()) throw new Error('Invalid owned extension entry point');
  await rejectForbiddenEntries(sourceDirectory);
}

async function validateOfficialClaudeSource(sourceDirectory: string): Promise<void> {
  const source = await lstat(sourceDirectory);
  if (!source.isDirectory() || source.isSymbolicLink()) {
    throw new Error('Official Claude extension source must be a real directory');
  }
  const packagePath = join(sourceDirectory, 'package.json');
  const packageStat = await lstat(packagePath);
  if (!packageStat.isFile() || packageStat.isSymbolicLink() || packageStat.size > 256 * 1024) {
    throw new Error('Invalid official Claude extension package');
  }
  const manifest = JSON.parse(await readFile(packagePath, 'utf8')) as Record<string, unknown>;
  const engines = manifest.engines as Record<string, unknown> | undefined;
  if (
    manifest.name !== OFFICIAL_CLAUDE_EXTENSION.name ||
    manifest.publisher !== OFFICIAL_CLAUDE_EXTENSION.publisher ||
    manifest.version !== OFFICIAL_CLAUDE_EXTENSION.version ||
    manifest.main !== OFFICIAL_CLAUDE_EXTENSION.main ||
    engines?.vscode !== OFFICIAL_CLAUDE_EXTENSION.vscodeEngine
  ) {
    throw new Error('Official Claude extension identity or version is invalid');
  }
  const main = await lstat(join(sourceDirectory, 'extension.js'));
  const binary = await lstat(join(sourceDirectory, 'resources', 'native-binary', 'claude'));
  if (!main.isFile() || main.isSymbolicLink() || !binary.isFile() || binary.isSymbolicLink() || !(binary.mode & 0o111)) {
    throw new Error('Official Claude extension entry point or binary is invalid');
  }
  await rejectForbiddenEntries(sourceDirectory);
}

async function rejectForbiddenEntries(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.name.toLowerCase().endsWith('.vsix')) throw new Error('VSIX files are forbidden');
    if (entry.isSymbolicLink()) throw new Error('Symbolic links are forbidden in extension sources');
    if (entry.isDirectory()) await rejectForbiddenEntries(path);
  }
}

async function hardlinkTree(source: string, target: string): Promise<void> {
  await mkdir(target, { recursive: false, mode: 0o755 });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (entry.isDirectory()) await hardlinkTree(sourcePath, targetPath);
    else if (entry.isFile()) await link(sourcePath, targetPath);
    else throw new Error('Unsupported extension package entry');
  }
}

async function makeImmutable(path: string): Promise<void> {
  const info = await stat(path);
  if (info.isDirectory()) {
    for (const entry of await readdir(path)) await makeImmutable(join(path, entry));
    await chmod(path, 0o555);
    return;
  }
  await chmod(path, info.mode & 0o111 ? 0o555 : 0o444);
}

function absoluteDirectory(value: string, label: string): string {
  if (typeof value !== 'string' || !isAbsolute(value) || value.includes('\0')) {
    throw new TypeError(`${label} directory must be absolute`);
  }
  const path = resolve(value);
  if (path === '/') throw new Error(`${label} directory cannot be the filesystem root`);
  return path;
}

function separatePaths(left: string, right: string): boolean {
  const leftToRight = relative(left, right);
  const rightToLeft = relative(right, left);
  return leftToRight !== '' &&
    (leftToRight.startsWith('..') || isAbsolute(leftToRight)) &&
    (rightToLeft.startsWith('..') || isAbsolute(rightToLeft));
}
