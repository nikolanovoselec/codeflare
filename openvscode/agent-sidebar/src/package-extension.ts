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
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';

export interface StageSidebarExtensionOptions {
  readonly sourceDirectory: string;
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
  const rootDirectory = absoluteDirectory(options.rootDirectory, 'root');
  if (!separatePaths(sourceDirectory, rootDirectory)) throw new Error('Source and staging root must be separate');
  await validateOwnedSource(sourceDirectory);

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
    await hardlinkTree(sharedExtension, join(inventories.claude, 'codeflare-agent-sidebar'));
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

async function rejectForbiddenEntries(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.name.toLowerCase().endsWith('.vsix')) throw new Error('VSIX files are forbidden');
    if (entry.isSymbolicLink()) throw new Error('Symbolic links are forbidden in the owned extension source');
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
