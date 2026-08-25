import { watch } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import * as vscode from 'vscode';

import { MANAGED_OPENVSCODE_SETTING_KEYS } from '../../claude/managed-settings.mjs';
import policyJson from '../../extension-persistence-policy.json' with { type: 'json' };

type JsonScalar = boolean | number | string | null;
type JsonValue = JsonScalar | { [key: string]: JsonValue };

interface ExtensionRecord {
  version: string;
  targetPlatform?: string;
  installedAt?: string;
  sha256?: string;
}

interface ExtensionManifest {
  version: 1;
  securityWarningShown?: boolean;
  extensions: Record<string, ExtensionRecord>;
  settings: Record<string, JsonValue>;
}

interface ManagedExtensionRecord {
  id: string;
  publisher: string;
  name: string;
  version: string;
  targetPlatform: string;
  engine: string;
  entrypoint: string;
  extensionPack: string[];
  extensionDependencies: string[];
  size: number;
  sha256: string;
  downloadUrl: string;
}

interface PersistenceOptions {
  extensionsDir?: string;
  manifestPath?: string;
  syncPidFile?: string;
  managedExtensionsPath?: string;
  managedReleaseDigest?: string | null;
  managedManifestDigest?: string | null;
  debounceMs?: number;
}

interface ResolvedOptions {
  extensionsDir: string;
  manifestPath: string;
  syncPidFile: string;
  managedExtensionsPath: string;
  managedReleaseDigest: string | null;
  managedManifestDigest: string | null;
  debounceMs: number;
}

export type ManifestLoadResult =
  | { state: 'absent' }
  | { state: 'invalid' }
  | { state: 'valid'; manifest: ExtensionManifest };

const policy = policyJson as {
  version: number;
  manifestMaxBytes: number;
  extensionMaxCount: number;
  settingsMaxBytes: number;
  settingValueMaxBytes: number;
  settingObjectMaxDepth: number;
  extensionIdPattern: string;
  extensionVersionPattern: string;
  extensionVersionMaxLength: number;
  targetPlatformPattern: string;
  installedAtPattern: string;
  sha256Pattern: string;
  fixedExtensionIds: string[];
  uiStateSettingKeys: string[];
};

const extensionIdPattern = new RegExp(policy.extensionIdPattern);
const extensionVersionPattern = new RegExp(policy.extensionVersionPattern);
const exactSemanticVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const targetPlatformPattern = new RegExp(policy.targetPlatformPattern);
const installedAtPattern = new RegExp(policy.installedAtPattern);
const sha256Pattern = new RegExp(policy.sha256Pattern);
const fixedExtensionIds = new Set(policy.fixedExtensionIds);
const excludedSettingKeys = new Set([...MANAGED_OPENVSCODE_SETTING_KEYS, ...policy.uiStateSettingKeys]);
const manifestTopKeys = new Set(['version', 'securityWarningShown', 'extensions', 'settings']);
const extensionRecordKeys = new Set(['version', 'targetPlatform', 'installedAt', 'sha256']);
const ACKNOWLEDGEMENT = 'I understand';
const INSTALL_COMMAND = 'workbench.extensions.installExtension';
const UNINSTALL_COMMAND = 'workbench.extensions.uninstallExtension';
const COMPANY_MANIFEST_MAX_BYTES = 256 * 1024;
const COMPANY_EXTENSION_MAX_BYTES = 128 * 1024 * 1024;
const COMPANY_EXTENSIONS_MAX_BYTES = 256 * 1024 * 1024;
const COMPANY_EXTENSION_MAX_COUNT = 20;
const COMPANY_RECONCILE_CONCURRENCY = 2;
const COMPANY_REQUEST_TIMEOUT_MS = 30_000;
const COMPANY_REDIRECT_HOST = 'openvsx.eclipsecontent.org';
const COMPANY_MARKER = '.codeflare-company-extensions.json';
const managedExtensionKeys = new Set([
  'id',
  'publisher',
  'name',
  'version',
  'targetPlatform',
  'engine',
  'entrypoint',
  'extensionPack',
  'extensionDependencies',
  'size',
  'sha256',
  'downloadUrl',
]);

function ownKeysAreAllowed(value: Record<string, unknown>, allowed: Set<string>): boolean {
  return Object.keys(value).every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function encodedLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function isPlainSetting(value: unknown, depth = 0): value is JsonValue {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (!isRecord(value) || depth >= policy.settingObjectMaxDepth) return false;
  return Object.entries(value).every(([key, child]) => (
    key.length > 0
    && key.length <= 256
    && isPlainSetting(child, depth + 1)
  ));
}

function isExtensionRecord(value: unknown): value is ExtensionRecord {
  if (!isRecord(value) || !ownKeysAreAllowed(value, extensionRecordKeys)) return false;
  if (typeof value.version !== 'string' || value.version.length > policy.extensionVersionMaxLength || !extensionVersionPattern.test(value.version)) return false;
  if (value.targetPlatform !== undefined && (typeof value.targetPlatform !== 'string' || !targetPlatformPattern.test(value.targetPlatform))) return false;
  if (value.installedAt !== undefined && (typeof value.installedAt !== 'string' || !installedAtPattern.test(value.installedAt))) return false;
  if (value.sha256 !== undefined && (typeof value.sha256 !== 'string' || !sha256Pattern.test(value.sha256))) return false;
  return true;
}

function isManifest(value: unknown): value is ExtensionManifest {
  if (!isRecord(value) || !ownKeysAreAllowed(value, manifestTopKeys) || value.version !== 1) return false;
  if (value.securityWarningShown !== undefined && typeof value.securityWarningShown !== 'boolean') return false;
  if (!isRecord(value.extensions) || Object.keys(value.extensions).length > policy.extensionMaxCount) return false;
  if (!isRecord(value.settings) || encodedLength(value.settings) > policy.settingsMaxBytes) return false;
  for (const [id, record] of Object.entries(value.extensions)) {
    if (!extensionIdPattern.test(id) || fixedExtensionIds.has(id) || !isExtensionRecord(record)) return false;
  }
  for (const [key, setting] of Object.entries(value.settings)) {
    if (key.length === 0 || key.length > 256 || encodedLength(setting) > policy.settingValueMaxBytes || !isPlainSetting(setting)) return false;
  }
  return true;
}

async function readBoundedRegularFile(path: string, maxBytes: number): Promise<Buffer> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > maxBytes) throw new Error('unsafe bounded file');
  const bytes = await readFile(path);
  if (bytes.length > maxBytes) throw new Error('file grew beyond bound');
  return bytes;
}

export async function loadExtensionManifest(manifestPath: string): Promise<ManifestLoadResult> {
  try {
    const bytes = await readBoundedRegularFile(manifestPath, policy.manifestMaxBytes);
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    return isManifest(parsed) ? { state: 'valid', manifest: parsed } : { state: 'invalid' };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'absent' };
    return { state: 'invalid' };
  }
}

function isManagedExtensionRecord(value: unknown): value is ManagedExtensionRecord {
  if (!isRecord(value) || !ownKeysAreAllowed(value, managedExtensionKeys) || Object.keys(value).length !== managedExtensionKeys.size) return false;
  if (typeof value.id !== 'string' || !extensionIdPattern.test(value.id)) return false;
  if (typeof value.publisher !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(value.publisher)) return false;
  if (typeof value.name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/.test(value.name)) return false;
  if (value.id !== `${value.publisher}.${value.name}`.toLowerCase()) return false;
  if (typeof value.version !== 'string' || value.version.length > 128 || !exactSemanticVersionPattern.test(value.version)) return false;
  if (typeof value.targetPlatform !== 'string' || !targetPlatformPattern.test(value.targetPlatform)) return false;
  if (typeof value.engine !== 'string' || value.engine.length === 0 || value.engine.length > 128) return false;
  if (typeof value.entrypoint !== 'string' || value.entrypoint.length === 0 || value.entrypoint.length > 512) return false;
  if (!Array.isArray(value.extensionPack) || !Array.isArray(value.extensionDependencies)) return false;
  if (![...value.extensionPack, ...value.extensionDependencies].every((id) => typeof id === 'string' && extensionIdPattern.test(id))) return false;
  if (typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size <= 0 || value.size > COMPANY_EXTENSION_MAX_BYTES) return false;
  if (typeof value.sha256 !== 'string' || !sha256Pattern.test(value.sha256)) return false;
  if (typeof value.downloadUrl !== 'string' || value.downloadUrl.length > 2_048) return false;
  try {
    const url = new URL(value.downloadUrl);
    const prefix = `/api/${encodeURIComponent(value.publisher)}/${encodeURIComponent(value.name)}/${encodeURIComponent(value.version)}/file/`;
    return url.protocol === 'https:'
      && url.hostname === 'open-vsx.org'
      && url.port === ''
      && url.username === ''
      && url.password === ''
      && url.search === ''
      && url.hash === ''
      && url.pathname.startsWith(prefix)
      && url.pathname.length > prefix.length;
  } catch {
    return false;
  }
}

async function loadManagedExtensions(
  path: string,
  expectedReleaseDigest: string | null,
  expectedManifestDigest: string | null,
): Promise<ManagedExtensionRecord[]> {
  if (!expectedReleaseDigest) return [];
  if (!expectedManifestDigest) throw new Error('missing trusted company extension manifest digest');
  try {
    const bytes = await readBoundedRegularFile(path, COMPANY_MANIFEST_MAX_BYTES);
    if (createHash('sha256').update(bytes).digest('hex') !== expectedManifestDigest) {
      throw new Error('company extension manifest digest mismatch');
    }
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    if (
      !isRecord(parsed)
      || !ownKeysAreAllowed(parsed, new Set(['schemaVersion', 'release', 'extensions']))
      || Object.keys(parsed).length !== 3
      || parsed.schemaVersion !== 1
      || !isRecord(parsed.release)
      || !ownKeysAreAllowed(parsed.release, new Set(['digest', 'sequence']))
      || Object.keys(parsed.release).length !== 2
      || typeof parsed.release.digest !== 'string'
      || parsed.release.digest !== expectedReleaseDigest
      || !sha256Pattern.test(parsed.release.digest)
      || typeof parsed.release.sequence !== 'number'
      || !Number.isSafeInteger(parsed.release.sequence)
      || parsed.release.sequence <= 0
      || !Array.isArray(parsed.extensions)
      || parsed.extensions.length > COMPANY_EXTENSION_MAX_COUNT
      || !parsed.extensions.every(isManagedExtensionRecord)
    ) {
      throw new Error('invalid company extension manifest');
    }
    const extensions = parsed.extensions;
    const ids = extensions.map(({ id }) => id);
    if (new Set(ids).size !== ids.length) throw new Error('duplicate company extension identity');
    const aggregate = extensions.reduce((total, extension) => total + extension.size, 0);
    if (aggregate > COMPANY_EXTENSIONS_MAX_BYTES) throw new Error('company extensions exceed aggregate bound');
    const required = new Set(ids);
    for (const extension of extensions) {
      if (![...extension.extensionPack, ...extension.extensionDependencies].every((id) => required.has(id))) {
        throw new Error('company extension dependency closure is incomplete');
      }
    }
    return [...extensions].sort((left, right) => left.id.localeCompare(right.id));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('active company extension manifest is missing');
    }
    throw error;
  }
}

function markerPath(extensionsDir: string): string {
  return join(extensionsDir, COMPANY_MARKER);
}

async function loadCompanyMarker(extensionsDir: string): Promise<Set<string>> {
  try {
    const bytes = await readBoundedRegularFile(markerPath(extensionsDir), policy.manifestMaxBytes);
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    if (!Array.isArray(parsed) || !parsed.every((id) => typeof id === 'string' && extensionIdPattern.test(id))) return new Set();
    return new Set(parsed);
  } catch {
    return new Set();
  }
}

async function companyProvenanceIds(
  extensionsDir: string,
  managedExtensionsPath: string,
  managedReleaseDigest: string | null,
  managedManifestDigest: string | null,
): Promise<Set<string>> {
  const active = new Set((await loadManagedExtensions(
    managedExtensionsPath,
    managedReleaseDigest,
    managedManifestDigest,
  )).map(({ id }) => id));
  const prior = await loadCompanyMarker(extensionsDir);
  return new Set([...prior, ...active]);
}

async function preserveCompanyMarker(extensionsDir: string, activeIds: readonly string[]): Promise<void> {
  const ids = [...new Set(activeIds)].sort();
  if (ids.length === 0) {
    await rm(markerPath(extensionsDir), { force: true });
    return;
  }
  await atomicWrite(markerPath(extensionsDir), `${JSON.stringify(ids)}\n`);
}

async function loadRegistry(extensionsDir: string): Promise<Record<string, ExtensionRecord>> {
  const path = join(extensionsDir, 'extensions.json');
  try {
    const bytes = await readBoundedRegularFile(path, policy.manifestMaxBytes * 16);
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    if (!Array.isArray(parsed)) throw new Error('invalid registry');
    const installed: Record<string, ExtensionRecord> = {};
    for (const rawEntry of parsed) {
      if (!isRecord(rawEntry) || !isRecord(rawEntry.identifier)) throw new Error('invalid registry entry');
      const rawId = rawEntry.identifier.id;
      const version = rawEntry.version;
      if (typeof rawId !== 'string' || typeof version !== 'string') throw new Error('invalid registry identity');
      const id = rawId.toLowerCase();
      if (!extensionIdPattern.test(id) || version.length > policy.extensionVersionMaxLength || !extensionVersionPattern.test(version)) throw new Error('invalid registry identity');
      if (fixedExtensionIds.has(id)) continue;
      const record: ExtensionRecord = { version };
      if (isRecord(rawEntry.metadata)) {
        const targetPlatform = rawEntry.metadata.targetPlatform;
        if (typeof targetPlatform === 'string' && targetPlatformPattern.test(targetPlatform)) record.targetPlatform = targetPlatform;
        const installedTimestamp = rawEntry.metadata.installedTimestamp;
        if (typeof installedTimestamp === 'number' && Number.isFinite(installedTimestamp) && installedTimestamp >= 0) {
          const installedDate = new Date(installedTimestamp);
          if (!Number.isNaN(installedDate.valueOf())) {
            const installedAt = installedDate.toISOString();
            if (installedAtPattern.test(installedAt)) record.installedAt = installedAt;
          }
        }
      }
      installed[id] = record;
    }
    if (Object.keys(installed).length > policy.extensionMaxCount) throw new Error('registry exceeds bound');
    return installed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw error;
  }
}

async function loadObsolete(extensionsDir: string): Promise<Set<string>> {
  try {
    const bytes = await readBoundedRegularFile(join(extensionsDir, '.obsolete'), policy.manifestMaxBytes);
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    if (!isRecord(parsed)) return new Set();
    return new Set(Object.entries(parsed)
      .filter(([, obsolete]) => obsolete === true)
      .map(([key]) => key.toLowerCase()));
  } catch {
    return new Set();
  }
}

function obsoleteProvesUninstall(
  id: string,
  observed: ExtensionRecord,
  obsolete: Set<string>,
  persisted?: ExtensionRecord,
): boolean {
  const records = persisted?.version === observed.version ? [observed, persisted] : [observed];
  return records.some((record) => {
    const stem = `${id}-${record.version}`;
    return obsolete.has(stem)
      || (record.targetPlatform !== undefined && obsolete.has(`${stem}-${record.targetPlatform}`));
  });
}

function stableValue(value: JsonValue | ExtensionManifest): unknown {
  if (Array.isArray(value)) return value.map((child) => stableValue(child as JsonValue));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key] as JsonValue)]));
}

function stableJson(value: ExtensionManifest): string {
  return `${JSON.stringify(stableValue(value))}\n`;
}

async function parentChainIsSafe(path: string): Promise<boolean> {
  let current = dirname(path);
  while (true) {
    try {
      if ((await lstat(current)).isSymbolicLink()) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
    }
    const next = dirname(current);
    if (next === current) return true;
    current = next;
  }
}

async function atomicWrite(path: string, payload: string): Promise<void> {
  if (!(await parentChainIsSafe(path))) throw new Error('unsafe manifest parent');
  const parent = dirname(path);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const temporary = join(parent, `.${basename(path)}.${process.pid}.${randomBytes(8).toString('hex')}`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(payload, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    const directory = await open(parent, 'r');
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function configurationProperties(extension: { packageJSON: unknown }): string[] {
  if (!isRecord(extension.packageJSON) || !isRecord(extension.packageJSON.contributes)) return [];
  const configuration = extension.packageJSON.contributes.configuration;
  const sections = Array.isArray(configuration) ? configuration : [configuration];
  const keys: string[] = [];
  for (const section of sections) {
    if (!isRecord(section) || !isRecord(section.properties)) continue;
    keys.push(...Object.keys(section.properties));
  }
  return keys;
}

function collectSettings(
  current: Record<string, JsonValue>,
  extensionIds: Set<string>,
): Record<string, JsonValue> {
  const settings: Record<string, JsonValue> = Object.fromEntries(
    Object.entries(current).filter(([key]) => !excludedSettingKeys.has(key)),
  );
  const keys = new Set<string>();
  for (const extension of vscode.extensions.all) {
    if (!extensionIds.has(extension.id.toLowerCase())) continue;
    for (const key of configurationProperties(extension)) {
      if (!excludedSettingKeys.has(key)) keys.add(key);
    }
  }
  const configuration = vscode.workspace.getConfiguration();
  for (const key of [...keys].sort()) {
    const globalValue: unknown = configuration.inspect(key)?.globalValue;
    if (globalValue === undefined) {
      delete settings[key];
    } else if (isPlainSetting(globalValue) && encodedLength(globalValue) <= policy.settingValueMaxBytes) {
      settings[key] = globalValue;
    }
  }
  const bounded: Record<string, JsonValue> = {};
  for (const key of Object.keys(settings).sort()) {
    const candidate = { ...bounded, [key]: settings[key] };
    if (encodedLength(candidate) <= policy.settingsMaxBytes) bounded[key] = settings[key];
  }
  return bounded;
}

async function acknowledgeExtensionSecurity(): Promise<boolean> {
  const result = await vscode.window.showWarningMessage(
    'User-installed extensions can execute arbitrary code as root inside this session and may read session files and credentials. Their contributed global settings are synced; do not store secrets in extension settings.',
    { modal: true },
    ACKNOWLEDGEMENT,
  );
  return result === ACKNOWLEDGEMENT;
}

async function signalSync(syncPidFile: string): Promise<void> {
  try {
    const bytes = await readBoundedRegularFile(syncPidFile, 32);
    const text = bytes.toString('ascii').trim();
    if (!/^[1-9][0-9]{0,9}$/.test(text)) return;
    process.kill(Number(text), 'SIGUSR1');
  } catch {
    // The existing sync daemon is optional; capture remains local if it is absent.
  }
}

async function persistSecurityAcknowledgement(options: ResolvedOptions): Promise<boolean> {
  const loaded = await loadExtensionManifest(options.manifestPath);
  if (loaded.state === 'invalid') return false;
  if (loaded.state === 'valid' && loaded.manifest.securityWarningShown === true) return true;
  const current: ExtensionManifest = loaded.state === 'valid'
    ? loaded.manifest
    : { version: 1, extensions: {}, settings: {} };
  let present: Record<string, ExtensionRecord>;
  let obsolete: Set<string>;
  let companyIds: Set<string>;
  try {
    present = await loadRegistry(options.extensionsDir);
    obsolete = await loadObsolete(options.extensionsDir);
    companyIds = await companyProvenanceIds(
      options.extensionsDir,
      options.managedExtensionsPath,
      options.managedReleaseDigest,
      options.managedManifestDigest,
    );
  } catch {
    return false;
  }
  const effectivePresent = Object.entries(present).filter(([id, observed]) => (
    !companyIds.has(id)
    && !obsoleteProvesUninstall(id, observed, obsolete, current.extensions[id])
  ));
  if (effectivePresent.length === 0) return true;
  if (!(await acknowledgeExtensionSecurity())) return false;
  const next: ExtensionManifest = { ...current, securityWarningShown: true };
  const payload = stableJson(next);
  if (!isManifest(next) || Buffer.byteLength(payload) > policy.manifestMaxBytes) return false;
  await atomicWrite(options.manifestPath, payload);
  await signalSync(options.syncPidFile);
  return true;
}

export async function captureExtensionManifest(
  options: Required<Pick<PersistenceOptions, 'extensionsDir' | 'manifestPath' | 'syncPidFile'>> & Pick<PersistenceOptions, 'managedExtensionsPath' | 'managedReleaseDigest' | 'managedManifestDigest'>,
): Promise<boolean> {
  const loaded = await loadExtensionManifest(options.manifestPath);
  if (loaded.state === 'invalid') return false;
  const current: ExtensionManifest = loaded.state === 'valid'
    ? loaded.manifest
    : { version: 1, extensions: {}, settings: {} };
  try {
    const present = await loadRegistry(options.extensionsDir);
    const obsolete = await loadObsolete(options.extensionsDir);
    const managedExtensionsPath = options.managedExtensionsPath ?? join(dirname(options.manifestPath), 'managed-extensions.json');
    const companyIds = await companyProvenanceIds(
      options.extensionsDir,
      managedExtensionsPath,
      options.managedReleaseDigest ?? null,
      options.managedManifestDigest ?? null,
    );
    const extensions: Record<string, ExtensionRecord> = {};
    for (const [id, record] of Object.entries(current.extensions)) {
      if (companyIds.has(id)) {
        extensions[id] = record;
      } else if (present[id] === undefined && !obsoleteProvesUninstall(id, record, obsolete)) {
        extensions[id] = record;
      }
    }
    for (const [id, observed] of Object.entries(present)) {
      if (companyIds.has(id) || obsoleteProvesUninstall(id, observed, obsolete, current.extensions[id])) continue;
      const digest = current.extensions[id]?.sha256;
      extensions[id] = digest === undefined ? observed : { ...observed, sha256: digest };
    }
    if (Object.keys(extensions).length > policy.extensionMaxCount) return false;

    const next: ExtensionManifest = {
      version: 1,
      extensions: Object.fromEntries(Object.entries(extensions).sort(([left], [right]) => left.localeCompare(right))),
      settings: collectSettings(current.settings, new Set(Object.keys(present).filter((id) => !companyIds.has(id)))),
      ...(current.securityWarningShown === undefined ? {} : { securityWarningShown: current.securityWarningShown }),
    };
    if (Object.keys(next.extensions).length > 0 && next.securityWarningShown !== true) {
      if (!(await acknowledgeExtensionSecurity())) return false;
      next.securityWarningShown = true;
    }
    if (!isManifest(next)) return false;
    const payload = stableJson(next);
    if (Buffer.byteLength(payload) > policy.manifestMaxBytes) return false;
    if (loaded.state === 'valid' && stableJson(current) === payload) return false;
    await atomicWrite(options.manifestPath, payload);
    await signalSync(options.syncPidFile);
    return true;
  } catch {
    return false;
  }
}

function validateCompanyRedirect(record: ManagedExtensionRecord, location: string): URL {
  const redirected = new URL(location);
  const filename = new URL(record.downloadUrl).pathname.split('/').at(-1);
  if (filename === undefined || filename.length === 0) throw new Error('company extension URL has no filename');
  const expectedPath = `/${encodeURIComponent(record.publisher)}/${encodeURIComponent(record.name)}/${encodeURIComponent(record.version)}/${filename}`;
  if (
    redirected.protocol !== 'https:'
    || redirected.hostname !== COMPANY_REDIRECT_HOST
    || redirected.port !== ''
    || redirected.username !== ''
    || redirected.password !== ''
    || redirected.search !== ''
    || redirected.hash !== ''
    || redirected.pathname !== expectedPath
  ) {
    throw new Error('company extension redirect is not allowed');
  }
  return redirected;
}

async function exactCompanyResponse(record: ManagedExtensionRecord): Promise<Response> {
  const initial = await fetch(new Request(record.downloadUrl, {
    headers: { Accept: 'application/octet-stream' },
    redirect: 'manual',
    signal: AbortSignal.timeout(COMPANY_REQUEST_TIMEOUT_MS),
  }));
  if (initial.status >= 300 && initial.status < 400) {
    const location = initial.headers.get('location');
    if (location === null) throw new Error('company extension redirect has no location');
    const redirected = validateCompanyRedirect(record, location);
    const response = await fetch(new Request(redirected, {
      headers: { Accept: 'application/octet-stream' },
      redirect: 'manual',
      signal: AbortSignal.timeout(COMPANY_REQUEST_TIMEOUT_MS),
    }));
    if (response.status >= 300 && response.status < 400) throw new Error('company extension exceeded redirect bound');
    if (!response.ok) throw new Error(`company extension download failed with HTTP ${response.status}`);
    return response;
  }
  if (!initial.ok) throw new Error(`company extension download failed with HTTP ${initial.status}`);
  return initial;
}

async function downloadCompanyExtension(record: ManagedExtensionRecord, destination: string): Promise<void> {
  const response = await exactCompanyResponse(record);
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength);
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0 || parsedLength > record.size) {
      throw new Error('company extension content length exceeds its signed bound');
    }
  }
  if (response.body === null) throw new Error('company extension response has no body');
  const reader = response.body.getReader();
  const digest = createHash('sha256');
  const handle = await open(destination, 'wx', 0o600);
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > record.size) {
        await reader.cancel();
        throw new Error('company extension exceeds its signed size');
      }
      digest.update(value);
      await handle.writeFile(value);
    }
    await handle.sync();
  } finally {
    reader.releaseLock();
    await handle.close();
  }
  if (size !== record.size) throw new Error('company extension size does not match its signed manifest');
  if (digest.digest('hex') !== record.sha256) throw new Error('company extension SHA-256 does not match its signed manifest');
}

async function installCompanyExtension(record: ManagedExtensionRecord): Promise<void> {
  const temporaryRoot = await mkdtemp(join(tmpdir(), 'codeflare-company-extension-'));
  const vsixPath = join(temporaryRoot, `${record.id}.vsix`);
  try {
    await downloadCompanyExtension(record, vsixPath);
    await vscode.commands.executeCommand(INSTALL_COMMAND, vscode.Uri.file(vsixPath), { donotSync: true });
  } finally {
    await rm(temporaryRoot, { force: true, recursive: true });
  }
}

export async function reconcileCompanyExtensions(
  options: Pick<ResolvedOptions, 'extensionsDir' | 'managedExtensionsPath'> & Partial<Pick<ResolvedOptions, 'managedReleaseDigest' | 'managedManifestDigest'>>,
): Promise<{ failures: string[]; managedIds: string[] }> {
  const suppliedReleaseDigest = options.managedReleaseDigest !== undefined
    ? options.managedReleaseDigest
    : process.env.REMOTE_CURATION_RELEASE_DIGEST ?? null;
  const expectedReleaseDigest = suppliedReleaseDigest && sha256Pattern.test(suppliedReleaseDigest)
    ? suppliedReleaseDigest
    : null;
  const suppliedManifestDigest = options.managedManifestDigest !== undefined
    ? options.managedManifestDigest
    : process.env.REMOTE_CURATION_MANIFEST_DIGEST ?? null;
  const expectedManifestDigest = suppliedManifestDigest && sha256Pattern.test(suppliedManifestDigest)
    ? suppliedManifestDigest
    : null;
  let managed: ManagedExtensionRecord[];
  try {
    managed = await loadManagedExtensions(
      options.managedExtensionsPath,
      expectedReleaseDigest,
      expectedManifestDigest,
    );
  } catch {
    try {
      await vscode.window.showWarningMessage(
        'Managed Browser IDE extensions could not be verified. Stop this session, then run “Recreate Agent Skills & Rules” in Codeflare Settings.',
      );
    } catch {
      // Reconciliation remains isolated from notification delivery.
    }
    const priorIds = [...await loadCompanyMarker(options.extensionsDir)].sort();
    return { failures: ['managed-extension-manifest'], managedIds: priorIds };
  }
  const managedIds = managed.map(({ id }) => id);
  const managedIdSet = new Set(managedIds);
  const priorIds = await loadCompanyMarker(options.extensionsDir);
  const failures: string[] = [];
  const failedRemovals: string[] = [];
  for (const id of [...priorIds].filter((priorId) => !managedIdSet.has(priorId)).sort()) {
    try {
      await vscode.commands.executeCommand(UNINSTALL_COMMAND, id, { donotSync: true });
    } catch {
      failures.push(id);
      failedRemovals.push(id);
    }
  }
  const protectedIds = [...new Set([...managedIds, ...failedRemovals])].sort();
  try {
    await preserveCompanyMarker(options.extensionsDir, protectedIds);
  } catch {
    try {
      await vscode.window.showWarningMessage('Company Browser IDE extensions could not be reconciled.');
    } catch {
      // Reconciliation remains isolated from notification delivery.
    }
    return { failures: [...new Set([...failures, ...managedIds])].sort(), managedIds: protectedIds };
  }
  // Registry identity cannot prove the installed bytes match the signed company
  // digest. Reinstall every active company requirement from its exact verified
  // VSIX; matching ID/version/platform metadata is not a trust boundary.
  const required = managed;
  const failedIds = new Set<string>();
  const pending = new Map(required.map((record) => [record.id, record]));
  while (pending.size > 0) {
    const ready = [...pending.values()].filter((record) => (
      [...record.extensionPack, ...record.extensionDependencies].every((id) => !pending.has(id))
    ));
    if (ready.length === 0) {
      for (const id of pending.keys()) {
        failures.push(id);
        failedIds.add(id);
      }
      break;
    }
    for (const record of ready) pending.delete(record.id);
    let next = 0;
    const worker = async () => {
      while (next < ready.length) {
        const record = ready[next];
        next += 1;
        if (record === undefined) continue;
        if ([...record.extensionPack, ...record.extensionDependencies].some((id) => failedIds.has(id))) {
          failures.push(record.id);
          failedIds.add(record.id);
          continue;
        }
        try {
          await installCompanyExtension(record);
        } catch {
          failures.push(record.id);
          failedIds.add(record.id);
        }
      }
    };
    await Promise.all(Array.from(
      { length: Math.min(COMPANY_RECONCILE_CONCURRENCY, ready.length) },
      () => worker(),
    ));
  }
  failures.sort();
  if (failures.length > 0) {
    const visible = failures.slice(0, 10).join(', ');
    const omitted = failures.length > 10 ? ` and ${failures.length - 10} more` : '';
    try {
      await vscode.window.showWarningMessage(`Could not reconcile company Browser IDE extensions: ${visible}${omitted}.`);
    } catch {
      // Reconciliation remains isolated from notification delivery.
    }
  }
  return { failures, managedIds: protectedIds };
}

function structuredNotFound(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const { code, name, status, statusCode } = error as {
    code?: unknown;
    name?: unknown;
    status?: unknown;
    statusCode?: unknown;
  };
  return code === 'ExtensionNotFound'
    || code === 'GalleryExtensionNotFound'
    || code === 'NotFound'
    || code === 404
    || status === 404
    || statusCode === 404
    || name === 'ExtensionNotFoundError'
    || name === 'NotFound';
}

async function restoreSettings(settings: Record<string, JsonValue>): Promise<void> {
  const configuration = vscode.workspace.getConfiguration();
  for (const [key, value] of Object.entries(settings).sort(([left], [right]) => left.localeCompare(right))) {
    if (excludedSettingKeys.has(key)) continue;
    try {
      await configuration.update(key, value, vscode.ConfigurationTarget.Global);
    } catch {
      // One stale contributed setting must not block extension restore.
    }
  }
}

export async function restoreExtensionManifest(
  options: Pick<ResolvedOptions, 'extensionsDir' | 'manifestPath'> & Partial<Pick<ResolvedOptions, 'syncPidFile'>>,
  managedIds: ReadonlySet<string> = new Set(),
): Promise<{ failures: string[] }> {
  const loaded = await loadExtensionManifest(options.manifestPath);
  if (loaded.state !== 'valid') return { failures: [] };
  let manifest = loaded.manifest;
  if (Object.keys(manifest.extensions).length > 0 && manifest.securityWarningShown !== true) {
    if (!(await acknowledgeExtensionSecurity())) return { failures: [] };
    manifest = { ...manifest, securityWarningShown: true };
    const payload = stableJson(manifest);
    if (!isManifest(manifest) || Buffer.byteLength(payload) > policy.manifestMaxBytes) return { failures: [] };
    await atomicWrite(options.manifestPath, payload);
    if (options.syncPidFile !== undefined) await signalSync(options.syncPidFile);
  }
  let installed: Record<string, ExtensionRecord>;
  try {
    installed = await loadRegistry(options.extensionsDir);
  } catch {
    return { failures: [] };
  }
  const missing = Object.entries(manifest.extensions)
    .filter(([id, record]) => !managedIds.has(id) && installed[id]?.version !== record.version)
    .sort(([left], [right]) => left.localeCompare(right));
  const failures: string[] = [];

  const restoreOne = async ([id, record]: [string, ExtensionRecord]) => {
    try {
      await vscode.commands.executeCommand(INSTALL_COMMAND, `${id}@${record.version}`, { donotSync: true });
    } catch (error) {
      if (!structuredNotFound(error)) {
        failures.push(id);
        return;
      }
      try {
        await vscode.commands.executeCommand(INSTALL_COMMAND, id, { donotSync: true });
      } catch {
        failures.push(id);
      }
    }
  };

  if (missing.length > 0) {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Restoring ${missing.length} user extension${missing.length === 1 ? '' : 's'}`,
        cancellable: false,
      },
      async () => {
        let next = 0;
        const worker = async () => {
          while (next < missing.length) {
            const entry = missing[next];
            next += 1;
            if (entry !== undefined) await restoreOne(entry);
          }
        };
        await Promise.all([worker(), worker()]);
      },
    );
  }
  await restoreSettings(manifest.settings);
  failures.sort();
  if (failures.length > 0) {
    const visible = failures.slice(0, 10).join(', ');
    const omitted = failures.length > 10 ? ` and ${failures.length - 10} more` : '';
    try {
      await vscode.window.showWarningMessage(`Could not restore user extensions: ${visible}${omitted}. Their manifest entries were preserved.`);
    } catch {
      // Restore completion does not depend on notification delivery.
    }
  }
  return { failures };
}

function resolveOptions(options: PersistenceOptions = {}): ResolvedOptions {
  const home = process.env.HOME ?? '/home/codeflare';
  return {
    extensionsDir: options.extensionsDir ?? process.env.CODEFLARE_OPENVSCODE_EXTENSIONS_DIR ?? '/run/codeflare/openvscode/data/extensions',
    manifestPath: options.manifestPath ?? process.env.CODEFLARE_IDE_EXTENSIONS_MANIFEST ?? join(home, '.codeflare', 'ide-extensions.json'),
    syncPidFile: options.syncPidFile ?? process.env.CODEFLARE_SYNC_DAEMON_PIDFILE ?? '/run/codeflare/sync/sync-daemon.pid',
    managedExtensionsPath: options.managedExtensionsPath ?? join(home, '.codeflare', 'managed-extensions.json'),
    managedReleaseDigest: (() => {
      const value = options.managedReleaseDigest !== undefined
        ? options.managedReleaseDigest
        : process.env.REMOTE_CURATION_RELEASE_DIGEST ?? null;
      return value && sha256Pattern.test(value) ? value : null;
    })(),
    managedManifestDigest: (() => {
      const value = options.managedManifestDigest !== undefined
        ? options.managedManifestDigest
        : process.env.REMOTE_CURATION_MANIFEST_DIGEST ?? null;
      return value && sha256Pattern.test(value) ? value : null;
    })(),
    debounceMs: options.debounceMs ?? 2_000,
  };
}

function affectsUserExtensionConfiguration(event: vscode.ConfigurationChangeEvent): boolean {
  for (const extension of vscode.extensions.all) {
    if (fixedExtensionIds.has(extension.id.toLowerCase())) continue;
    for (const key of configurationProperties(extension)) {
      if (!excludedSettingKeys.has(key) && event.affectsConfiguration(key)) return true;
    }
  }
  return false;
}

export async function activateExtensionPersistence(
  context: Pick<vscode.ExtensionContext, 'subscriptions'>,
  options: PersistenceOptions = {},
): Promise<() => Promise<void>> {
  const resolved = resolveOptions(options);
  const company = await reconcileCompanyExtensions(resolved);
  await restoreExtensionManifest(resolved, new Set(company.managedIds));
  let timer: NodeJS.Timeout | undefined;
  let capturePending = false;
  let captureChain = Promise.resolve();
  let operationChain = Promise.resolve();
  const capture = () => {
    captureChain = captureChain
      .then(() => captureExtensionManifest(resolved))
      .then(() => undefined, () => undefined);
    return captureChain;
  };
  const runPendingCapture = () => {
    operationChain = operationChain
      .then(async () => {
        if (!capturePending) return;
        capturePending = false;
        if (await persistSecurityAcknowledgement(resolved)) await capture();
      })
      .then(() => undefined, () => undefined);
    return operationChain;
  };
  const scheduleCapture = () => {
    capturePending = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      void runPendingCapture();
    }, resolved.debounceMs);
  };

  context.subscriptions.push(
    vscode.extensions.onDidChange(scheduleCapture),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (affectsUserExtensionConfiguration(event)) scheduleCapture();
    }),
  );
  try {
    const watcher = watch(resolved.extensionsDir, (_event, filename) => {
      const name = filename?.toString();
      if (name === 'extensions.json' || name === '.obsolete') scheduleCapture();
    });
    watcher.on('error', () => undefined);
    context.subscriptions.push({ dispose: () => watcher.close() });
  } catch {
    // The extension-host event remains authoritative when a filesystem watcher is unavailable.
  }
  context.subscriptions.push({
    dispose: () => {
      if (timer !== undefined) clearTimeout(timer);
    },
  });
  await capture();
  return async () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    await runPendingCapture();
    await captureChain;
  };
}
