#!/usr/bin/env node
import {
  KeyObject,
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from 'node:crypto';
import { posix as pathPosix } from 'node:path';
import { gzipSync } from 'node:zlib';
import { compileAgentSeed } from './agent-seed-core.mjs';
import {
  MANAGED_RELEASE_CONTENT_TYPES,
  MANAGED_RELEASE_LIMITS,
  isExactManagedExtensionVersion,
  isManagedReleaseContextModePath,
  validateManagedReleasePath,
  validateManagedRetiredPath,
} from './agent-seed-release-limits.mjs';

export const SEED_ABI = 1;

const MODES = new Set(['default', 'advanced']);
const FULL_SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const measuredExtensionRecords = new WeakSet();
const SUPPORTED_CONTENT_TYPES = new Set(MANAGED_RELEASE_CONTENT_TYPES);
const MANAGED_PI_EXTENSION_PREFIX = '.pi/agent/extensions/';

export const IMAGE_OWNED_MANAGED_EXTENSION_COMPANIONS = Object.freeze([
  Object.freeze({
    key: '.pi/agent/extensions/context-mode-runtime.ts',
    importers: Object.freeze(['.pi/agent/extensions/ctx-command.ts']),
    modes: Object.freeze(['advanced', 'default']),
  }),
]);

function compareStrings(left, right) {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function requireString(value, label) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function requireBoundedString(value, label, maximum = 512) {
  const string = requireString(value, label);
  if (string.length > maximum || /[\u0000-\u001f\u007f]/.test(string)) {
    throw new Error(`${label} is outside the allowed string bounds`);
  }
  return string;
}

function validateReleasePath(value, label) {
  return validateManagedReleasePath(value, label);
}

function validateSequence(sequence, previousSequence) {
  if (!Number.isInteger(sequence) || sequence <= 0 || sequence > (2 ** 32)) {
    throw new Error('sequence must be a positive integer no greater than 2^32');
  }
  if (!Number.isSafeInteger(previousSequence) || previousSequence < 0) {
    throw new Error('previousSequence must be a non-negative safe integer');
  }
  if (sequence <= previousSequence) {
    throw new Error('sequence must be greater than previousSequence');
  }
}

function validateRepositoryId(repositoryId) {
  if (!Number.isSafeInteger(repositoryId) || repositoryId <= 0) {
    throw new Error('repositoryId must be a positive safe integer');
  }
}

function validateSha(value, label) {
  if (typeof value !== 'string' || !FULL_SHA.test(value)) {
    throw new Error(`${label} must be a full lowercase 40-hex commit SHA`);
  }
}

function normalizeDocuments(documents) {
  if (!Array.isArray(documents)) throw new Error('compiled documents must be an array');
  if (documents.length > MANAGED_RELEASE_LIMITS.documentCount) throw new Error('document count exceeds the fixed limit');
  const normalized = [];
  const seen = new Set();
  let totalDocumentBytes = 0;

  for (const [index, document] of documents.entries()) {
    if (!document || typeof document !== 'object') {
      throw new Error(`document ${index} must be an object`);
    }
    const key = validateReleasePath(document.key, `document ${index} path`);
    const contentType = requireBoundedString(document.contentType, `document ${index} contentType`, 256);
    if (!SUPPORTED_CONTENT_TYPES.has(contentType)) {
      throw new Error(`document ${index} contentType is unsupported: ${contentType}`);
    }
    if (typeof document.content !== 'string') {
      throw new Error(`document ${index} content must be a string`);
    }
    const contentBytes = Buffer.byteLength(document.content, 'utf8');
    if (contentBytes > MANAGED_RELEASE_LIMITS.documentBytes) {
      throw new Error(`document ${index} bytes exceed the fixed document limit`);
    }
    totalDocumentBytes += contentBytes;
    if (totalDocumentBytes > MANAGED_RELEASE_LIMITS.totalDocumentBytes) {
      throw new Error('total document bytes exceed the fixed limit');
    }
    if (!Array.isArray(document.modes) || document.modes.length === 0) {
      throw new Error(`document ${index} modes must be a non-empty array`);
    }

    const modes = [];
    for (const mode of document.modes) {
      if (!MODES.has(mode)) throw new Error(`document ${index} has invalid mode: ${String(mode)}`);
      const identity = `${key}\u0000${mode}`;
      if (seen.has(identity)) {
        throw new Error(`duplicate document key-mode pair: ${key} (${mode})`);
      }
      seen.add(identity);
      modes.push(mode);
    }
    normalized.push({
      key,
      contentType,
      content: document.content,
      modes: modes.sort(compareStrings),
    });
  }

  return normalized.sort((left, right) => (
    compareStrings(left.key, right.key)
    || compareStrings(left.modes.join(','), right.modes.join(','))
  ));
}

function relativeModuleSpecifiers(content) {
  const specifiers = new Set();
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?(?:[^"'`;]*?\s+from\s+)?(["'])(\.[^"'\r\n]+)\1/g,
    /\b(?:import|require)\s*\(\s*(["'])(\.[^"'\r\n]+)\1\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) specifiers.add(match[2]);
  }
  return [...specifiers].sort(compareStrings);
}

function relativeModuleCandidates(sourceKey, specifier) {
  const resolved = pathPosix.normalize(pathPosix.join(pathPosix.dirname(sourceKey), specifier));
  const extension = pathPosix.extname(resolved);
  if (extension === '.js') return [resolved, `${resolved.slice(0, -3)}.ts`];
  if (extension) return [resolved];
  return [
    resolved,
    `${resolved}.ts`,
    `${resolved}.js`,
    `${resolved}.mjs`,
    `${resolved}.cjs`,
    `${resolved}/index.ts`,
    `${resolved}/index.js`,
  ];
}

function validateManagedExtensionImportClosure(documents) {
  const documentsByKey = new Map();
  for (const document of documents) {
    const existing = documentsByKey.get(document.key) ?? [];
    existing.push(document);
    documentsByKey.set(document.key, existing);
  }

  for (const document of documents) {
    if (!document.key.startsWith(MANAGED_PI_EXTENSION_PREFIX)) continue;
    for (const specifier of relativeModuleSpecifiers(document.content)) {
      const candidates = relativeModuleCandidates(document.key, specifier);
      for (const mode of document.modes) {
        const releaseOwnsImport = candidates.some((candidate) => (
          (documentsByKey.get(candidate) ?? []).some((dependency) => dependency.modes.includes(mode))
        ));
        const imageOwnsImport = IMAGE_OWNED_MANAGED_EXTENSION_COMPANIONS.some((companion) => (
          candidates.includes(companion.key)
          && companion.importers.includes(document.key)
          && companion.modes.includes(mode)
        ));
        if (!releaseOwnsImport && !imageOwnsImport) {
          throw new Error(`managed extension relative import ${specifier} from ${document.key} is not declared for ${mode} mode`);
        }
      }
    }
  }
}

function normalizeRetiredPaths(retiredKeys, livePaths) {
  if (!Array.isArray(retiredKeys)) throw new Error('compiled retiredKeys must be an array');
  const remotelyOwnedRetiredKeys = retiredKeys.filter((retiredPath) => !isManagedReleaseContextModePath(retiredPath));
  if (remotelyOwnedRetiredKeys.length > MANAGED_RELEASE_LIMITS.retiredPathCount) throw new Error('retired path count exceeds the fixed limit');
  const seen = new Set();
  const retiredPaths = remotelyOwnedRetiredKeys.map((retiredPath, index) => {
    const validated = validateManagedRetiredPath(retiredPath, `retired path ${index}`);
    if (seen.has(validated)) throw new Error(`duplicate retired path: ${validated}`);
    if (livePaths.has(validated)) throw new Error(`path is both live and retired: ${validated}`);
    seen.add(validated);
    return validated;
  });
  return retiredPaths.sort(compareStrings);
}

function normalizeExtensionIds(value, label) {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const seen = new Set();
  const ids = value.map((raw, index) => {
    const id = requireBoundedString(raw, `${label}[${index}]`, 256).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]*\.[a-z0-9][a-z0-9-]*$/.test(id)) {
      throw new Error(`${label}[${index}] must be a publisher.name extension identity`);
    }
    if (seen.has(id)) throw new Error(`${label} contains duplicate identity: ${id}`);
    seen.add(id);
    return id;
  });
  return ids.sort(compareStrings);
}

/**
 * Derive a release extension record from downloaded artifact bytes and the
 * package manifest extracted from that artifact. Curator-supplied size, hash,
 * and identity fields are never accepted by the release builder.
 */
export function measureExtensionRecord({ bytes, manifest, platform, downloadUrl }) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
    throw new Error('extension bytes must be a non-empty Uint8Array');
  }
  if (bytes.byteLength > MANAGED_RELEASE_LIMITS.extensionBytes) {
    throw new Error('extension bytes exceed the fixed per-extension limit');
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('extension manifest must be an object extracted from the artifact');
  }

  const publisher = requireBoundedString(manifest.publisher, 'extension publisher', 128);
  const name = requireBoundedString(manifest.name, 'extension name', 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(publisher) || !/^[A-Za-z0-9][A-Za-z0-9-]*$/.test(name)) {
    throw new Error('extension publisher and name must form a valid identity');
  }
  const version = requireBoundedString(manifest.version, 'extension version', 128);
  if (!isExactManagedExtensionVersion(version)) {
    throw new Error('extension version must be an exact semantic version');
  }
  const measuredPlatform = requireBoundedString(platform, 'extension platform', 64);
  if (!/^[a-z0-9][a-z0-9-]*$/.test(measuredPlatform)) {
    throw new Error('extension platform is invalid');
  }
  const engine = requireBoundedString(manifest.engines?.vscode, 'extension VS Code engine', 128);
  const entrypoint = requireBoundedString(
    manifest.browser ?? manifest.main,
    'extension entrypoint',
    512,
  );
  const extensionPack = normalizeExtensionIds(manifest.extensionPack, 'extensionPack');
  const dependencies = normalizeExtensionIds(manifest.extensionDependencies, 'extensionDependencies');
  const exactDownloadUrl = new URL(requireBoundedString(downloadUrl, 'extension downloadUrl', 2_048));
  if (exactDownloadUrl.protocol !== 'https:' || exactDownloadUrl.hostname !== 'open-vsx.org') {
    throw new Error('extension downloadUrl must use the exact Open VSX HTTPS host');
  }
  const expectedDownloadPrefix = `/api/${encodeURIComponent(publisher)}/${encodeURIComponent(name)}/${encodeURIComponent(version)}/file/`;
  if (!exactDownloadUrl.pathname.startsWith(expectedDownloadPrefix)) {
    throw new Error('extension downloadUrl does not match the measured identity and version');
  }
  const record = Object.freeze({
    id: `${publisher}.${name}`.toLowerCase(),
    publisher,
    name,
    version,
    targetPlatform: measuredPlatform,
    engine,
    entrypoint,
    extensionPack: Object.freeze(extensionPack),
    extensionDependencies: Object.freeze(dependencies),
    downloadUrl: exactDownloadUrl.toString(),
    size: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  });
  measuredExtensionRecords.add(record);
  return record;
}

function validateExtensions(extensions) {
  if (!Array.isArray(extensions)) throw new Error('extensions must be an array');
  if (extensions.length > MANAGED_RELEASE_LIMITS.extensionCount) throw new Error('extension count exceeds the fixed limit');
  const seen = new Set();
  let aggregateBytes = 0;
  for (const extension of extensions) {
    if (!extension || typeof extension !== 'object' || !measuredExtensionRecords.has(extension)) {
      throw new Error('every extension record must come from measureExtensionRecord');
    }
    const identity = `${extension.id}\u0000${extension.targetPlatform}`;
    if (seen.has(identity)) throw new Error(`duplicate measured extension: ${extension.id} (${extension.targetPlatform})`);
    seen.add(identity);
    aggregateBytes += extension.size;
    if (aggregateBytes > MANAGED_RELEASE_LIMITS.aggregateExtensionBytes) {
      throw new Error('aggregate extension bytes exceed the fixed limit');
    }
  }

  const ids = new Set(extensions.map((extension) => extension.id));
  for (const extension of extensions) {
    for (const required of [...extension.extensionPack, ...extension.extensionDependencies]) {
      if (!ids.has(required)) {
        throw new Error(`extension dependency closure is incomplete: ${extension.id} requires ${required}`);
      }
    }
  }

  return [...extensions].sort((left, right) => (
    compareStrings(left.id, right.id)
    || compareStrings(left.version, right.version)
    || compareStrings(left.targetPlatform, right.targetPlatform)
  ));
}

export async function buildAgentSeedRelease({
  sourceRoot,
  sequence,
  previousSequence,
  repositoryId,
  sourceSha,
  compilerSha,
  releaseTag,
  managedExtensions = [],
  compile = compileAgentSeed,
}) {
  requireString(sourceRoot, 'sourceRoot');
  validateSequence(sequence, previousSequence);
  validateRepositoryId(repositoryId);
  validateSha(sourceSha, 'sourceSha');
  validateSha(compilerSha, 'compilerSha');
  requireBoundedString(releaseTag, 'releaseTag', 256);
  if (typeof compile !== 'function') throw new Error('compile must be a function');

  const compiled = await compile({ rootDir: sourceRoot });
  if (!compiled || typeof compiled !== 'object') throw new Error('compiler returned no release input');
  if (typeof compiled.runtimeHash !== 'string' || !SHA256.test(compiled.runtimeHash)) {
    throw new Error('compiler runtimeHash must be a lowercase SHA-256 digest');
  }

  const documents = normalizeDocuments(compiled.documents);
  validateManagedExtensionImportClosure(documents);
  const livePaths = new Set(documents.map((document) => document.key));
  const retiredPaths = normalizeRetiredPaths(compiled.retiredKeys, livePaths);
  const extensions = validateExtensions(managedExtensions);

  return {
    seedAbi: SEED_ABI,
    sequence,
    source: {
      repositoryId,
      commitSha: sourceSha,
      releaseTag,
      compilerCommit: compilerSha,
    },
    runtimeDependencyHash: compiled.runtimeHash,
    documents,
    retiredPaths,
    managedExtensions: extensions,
  };
}

export function createReleaseBundle(release) {
  if (!release || typeof release !== 'object' || release.seedAbi !== SEED_ABI) {
    throw new Error('release must be a built seed-v1 contract');
  }
  const json = `${JSON.stringify(release)}\n`;
  const jsonBytes = Buffer.from(json, 'utf8');
  if (jsonBytes.byteLength > MANAGED_RELEASE_LIMITS.expandedBytes) {
    throw new Error('expanded release bundle exceeds the fixed limit');
  }
  const gzip = gzipSync(jsonBytes, { level: 9, mtime: 0 });
  if (gzip.byteLength > MANAGED_RELEASE_LIMITS.compressedBytes) {
    throw new Error('compressed release bundle exceeds the fixed limit');
  }
  return { json, gzip };
}

function privateEd25519Key(value) {
  const key = value instanceof KeyObject ? value : createPrivateKey(value);
  if (key.type !== 'private' || key.asymmetricKeyType !== 'ed25519') {
    throw new Error('private key must be Ed25519');
  }
  return key;
}

function publicEd25519Key(value) {
  const key = value instanceof KeyObject ? value : createPublicKey(value);
  if (key.type !== 'public' || key.asymmetricKeyType !== 'ed25519') {
    throw new Error('public key must be Ed25519');
  }
  return key;
}

export function signReleaseBundle(gzipBytes, privateKey) {
  if (!(gzipBytes instanceof Uint8Array)) throw new Error('gzipBytes must be a Uint8Array');
  return sign(null, gzipBytes, privateEd25519Key(privateKey));
}

export function verifyReleaseBundle(gzipBytes, signature, publicKey) {
  if (!(gzipBytes instanceof Uint8Array) || !(signature instanceof Uint8Array)) return false;
  try {
    return verify(null, gzipBytes, publicEd25519Key(publicKey), signature);
  } catch {
    return false;
  }
}