import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const encoder = new TextEncoder();
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const PATH_CHARS = /^[A-Za-z0-9_@./~-]+$/;
const CAPABILITIES = new Set(['session', 'pi', 'storage', 'inference', 'fetch']);
function fail(message) { throw new Error(`Invalid operator package: ${message}`); }
function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${name} must be an object`);
  return value;
}
function exactKeys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`${name} contains unsupported field ${key}`);
}
function string(value, name, min, max) {
  if (typeof value !== 'string' || value.length < min || value.length > max) fail(`${name} is invalid`);
}
function canonicalPath(value, absolute = false) {
  return typeof value === 'string' && value.length <= 512 && value.startsWith('/') === absolute
    && PATH_CHARS.test(value) && (absolute ? value.slice(1) : value).split('/').every(segment =>
      segment && segment !== '.' && segment !== '..' && segment !== '__proto__'
      && segment !== 'constructor' && segment !== 'prototype');
}
function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function jsonBytes(value) { return encoder.encode(`${JSON.stringify(stable(value))}\n`); }
function validateModules(modules, mainModule) {
  object(modules, 'bundle.modules');
  const names = Object.keys(modules);
  if (!names.length || names.length > 128) fail('bundle.modules count is invalid');
  for (const name of names) {
    if (!canonicalPath(name)) fail(`module path ${name} is not canonical`);
    const module = object(modules[name], `module ${name}`);
    const keys = Object.keys(module);
    if (keys.length !== 1 || !['js', 'text'].includes(keys[0]) || typeof module[keys[0]] !== 'string') fail(`module ${name} is invalid`);
  }
  if (!canonicalPath(mainModule) || !modules[mainModule] || !Object.hasOwn(modules[mainModule], 'js')) fail('mainModule must name a JavaScript module');
}

async function normalizeResources(resources, modules) {
  if (resources === undefined) return undefined;
  const input = object(resources, 'bundle.resources');
  exactKeys(input, ['schemaVersion', 'files'], 'bundle.resources');
  if (input.schemaVersion !== 1 || !Array.isArray(input.files) || input.files.length > 64) fail('bundle.resources is invalid');
  const destinations = new Set();
  const files = [];
  for (const raw of input.files) {
    const file = object(raw, 'resource');
    exactKeys(file, ['source', 'destination', 'sha256', 'size'], 'resource');
    if (!canonicalPath(file.source) || !canonicalPath(file.destination)) fail('resource path is not canonical');
    if (destinations.has(file.destination)) fail('resource destinations must be unique');
    destinations.add(file.destination);
    const module = modules[file.source];
    if (!module || !Object.hasOwn(module, 'text')) fail('resource source must name a text module');
    const bytes = encoder.encode(module.text);
    if (bytes.byteLength > 1024 * 1024) fail('resource exceeds the size limit');
    const digest = sha(bytes);
    if (file.sha256 !== undefined && file.sha256 !== digest) fail('resource digest does not match exact bytes');
    if (file.size !== undefined && file.size !== bytes.byteLength) fail('resource size does not match exact bytes');
    files.push({ source: file.source, destination: file.destination, sha256: digest, size: bytes.byteLength });
  }
  return { schemaVersion: 1, files };
}

async function buildBundle(raw) {
  const bundle = { ...object(raw, 'bundle') };
  const dispatcher = Object.hasOwn(bundle, 'sourceCommit') || Object.hasOwn(bundle, 'className') || Object.hasOwn(bundle, 'versions');
  if (dispatcher) {
    exactKeys(bundle, ['schemaVersion', 'sourceCommit', 'versions', 'className', 'compatibilityDate', 'compatibilityFlags', 'mainModule', 'modules'], 'Dispatcher bundle');
    if (bundle.schemaVersion !== 1 || !COMMIT.test(bundle.sourceCommit || '') || bundle.className !== 'FlueDispatcherAgent'
      || bundle.compatibilityDate !== '2026-09-10' || JSON.stringify(bundle.compatibilityFlags) !== '["nodejs_compat"]') fail('Dispatcher bundle metadata is incompatible');
    const versions = object(bundle.versions, 'bundle.versions');
    exactKeys(versions, ['runtime', 'vitePlugin', 'agents'], 'bundle.versions');
    if (versions.runtime !== '2.1.0' || versions.vitePlugin !== '2.1.0' || versions.agents !== '0.20.1') fail('Dispatcher versions are incompatible');
    validateModules(bundle.modules, bundle.mainModule);
    return { bundle, dispatcher: true };
  }
  exactKeys(bundle, ['schemaVersion', 'interfaceVersion', 'compatibilityDate', 'compatibilityFlags', 'mainModule', 'modules', 'resources'], 'Operator bundle');
  if (bundle.schemaVersion !== 1 || bundle.interfaceVersion !== 1 || bundle.compatibilityDate !== '2026-02-05'
    || JSON.stringify(bundle.compatibilityFlags) !== '["nodejs_compat"]') fail('Operator bundle metadata is incompatible');
  validateModules(bundle.modules, bundle.mainModule);
  const resources = await normalizeResources(bundle.resources, bundle.modules);
  if (resources === undefined) delete bundle.resources; else bundle.resources = resources;
  return { bundle, dispatcher: false };
}

function buildManifest(raw, bundleDigest, dispatcher) {
  const manifest = { ...object(raw, 'manifest'), artifact: { path: '/operator-bundle.json', sha256: bundleDigest } };
  exactKeys(manifest, ['schemaVersion', 'interfaceVersion', 'id', 'name', 'description', 'coreVersion', 'intentVersion', 'profile', 'inputSchema', 'outputSchema', 'requiredCapabilities', 'artifact'], 'manifest');
  if (manifest.schemaVersion !== 1 || manifest.interfaceVersion !== 1 || !ID.test(manifest.id || '')) fail('manifest identity is invalid');
  string(manifest.name, 'manifest.name', 1, 256); string(manifest.description, 'manifest.description', 0, 4096);
  string(manifest.coreVersion, 'manifest.coreVersion', 1, 128); string(manifest.intentVersion, 'manifest.intentVersion', 1, 128);
  if (manifest.name.trim() !== manifest.name || !['conductor', 'dispatcher', undefined].includes(manifest.profile)) fail('manifest metadata is invalid');
  if (dispatcher && manifest.profile !== 'dispatcher') fail('Dispatcher bundle requires the dispatcher profile');
  object(manifest.inputSchema, 'manifest.inputSchema');
  if (manifest.outputSchema !== undefined) object(manifest.outputSchema, 'manifest.outputSchema');
  if (!Array.isArray(manifest.requiredCapabilities) || manifest.requiredCapabilities.length > 5
    || new Set(manifest.requiredCapabilities).size !== manifest.requiredCapabilities.length
    || manifest.requiredCapabilities.some(value => !CAPABILITIES.has(value))) fail('manifest capabilities are invalid');
  return manifest;
}

function buildProvenance(raw, manifestDigest, bundleDigest, sourceCommit) {
  if (raw === undefined) return undefined;
  const provenance = { ...object(raw, 'provenance'), manifestDigest, bundleDigest };
  exactKeys(provenance, ['repositoryId', 'sourceCommit', 'compilerCommit', 'manifestDigest', 'bundleDigest', 'workflow'], 'provenance');
  if (!Number.isSafeInteger(provenance.repositoryId) || provenance.repositoryId <= 0 || !COMMIT.test(provenance.sourceCommit || '')
    || !COMMIT.test(provenance.compilerCommit || '')
    || provenance.sourceCommit !== sourceCommit && sourceCommit !== undefined) fail('provenance source is invalid');
  const workflow = object(provenance.workflow, 'provenance.workflow');
  exactKeys(workflow, ['id', 'ref', 'runId', 'runAttempt'], 'provenance.workflow');
  for (const key of ['id', 'runId', 'runAttempt']) if (!Number.isSafeInteger(workflow[key]) || workflow[key] <= 0) fail('provenance workflow is invalid');
  string(workflow.ref, 'provenance.workflow.ref', 1, 512);
  return provenance;
}

export async function compileOperatorPackage(input) {
  const config = object(input, 'configuration');
  exactKeys(config, ['manifest', 'bundle', 'provenance'], 'configuration');
  const { bundle, dispatcher } = await buildBundle(config.bundle);
  const bundleBytes = jsonBytes(bundle);
  if (bundleBytes.byteLength > 8 * 1024 * 1024) fail('bundle exceeds the size limit');
  const manifest = buildManifest(config.manifest, sha(bundleBytes), dispatcher);
  const manifestBytes = jsonBytes(manifest);
  if (manifestBytes.byteLength > 64 * 1024) fail('manifest exceeds the size limit');
  const provenance = buildProvenance(config.provenance, sha(manifestBytes), sha(bundleBytes), dispatcher ? bundle.sourceCommit : undefined);
  const files = new Map([['operator-manifest.json', manifestBytes], ['operator-bundle.json', bundleBytes]]);
  if (provenance) files.set('operator-provenance.json', jsonBytes(provenance));
  return { files, manifest, bundle, provenance, manifestDigest: sha(manifestBytes), bundleDigest: sha(bundleBytes) };
}

export async function writeOperatorPackage(input, outputDirectory) {
  const compiled = await compileOperatorPackage(input);
  await mkdir(outputDirectory, { recursive: true });
  for (const [name, bytes] of compiled.files) await writeFile(join(outputDirectory, name), bytes, { flag: 'wx' });
  return compiled;
}
