/** REQ-OPERATOR-030/044/045/046: platform facts, not caller metadata, qualify a normal deployment. */
import type { Env } from '../types';
import { CF_API_BASE } from '../lib/constants';
import { SETUP_KEYS } from '../lib/kv-keys';
import { readBoundedResponse } from '../lib/bounded-stream';
import { parseDispatcherBundle } from './distribution';
import { DEFAULT_SUBMISSION_ATTEMPT_LIMIT } from './dispatcher-submission-limits';
import { sealOperatorSecret } from './protected-secrets';
import type { DispatcherConnectionMetadata } from './registry';

export interface DispatcherDeploymentVerification {
  connectionRevision: number; workerVersionId: string; bundleDigest: string; controlOrigin: string;
}
const denied = (): never => { throw new Error('Dispatcher deployment could not be verified'); };

/** REQ-OPERATOR-046 AC4/6/7: one new shared installation candidate; never overwrite SDK storage.
 * The authorized caller owns Registry selection. An uncertain upload is not retried or deleted. */
export async function provisionDispatcherDeployment(env: Env,
  pin: Omit<DispatcherConnectionMetadata, 'workerName' | 'workerVersionId'>,
  bytes: Uint8Array, admittedSubmissionAttemptLimit: number, reauthorize: () => Promise<void>): Promise<{
    connection: DispatcherConnectionMetadata; connectionSecret: string; verification: DispatcherDeploymentVerification;
  }> {
  const bundle = await parseDispatcherBundle(bytes, pin.bundleDigest);
  if (bundle.schemaVersion !== 2 || !bundle.hosting || bundle.sourceCommit !== pin.sourceCommit
    || !/^[0-9a-f]{40}$/.test(pin.compilerCommit)
    || !Number.isSafeInteger(admittedSubmissionAttemptLimit) || admittedSubmissionAttemptLimit < 1) return denied();
  const parentName = env.CLOUDFLARE_WORKER_NAME;
  if (typeof parentName !== 'string' || !/^[a-z0-9_][a-z0-9_-]*$/.test(parentName)
    || !env.CLOUDFLARE_API_TOKEN) return denied();
  const account = await env.KV.get(SETUP_KEYS.ACCOUNT_ID);
  if (!account || !/^[a-f0-9]{32}$/.test(account)) return denied();
  await reauthorize();
  const connectionSecret = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  // Prove encryption is available before protected upload; Registry owns the persisted envelope.
  await sealOperatorSecret(connectionSecret, env, { purpose: 'connection', recordId: pin.installationId });
  const workerName = `dispatcher-${crypto.randomUUID()}`;
  const base = `${CF_API_BASE}/accounts/${account}/workers/scripts/${workerName}`;
  const signal = AbortSignal.timeout(15000);
  const json = async (url: string, method: 'GET' | 'PUT' | 'POST', body?: BodyInit, contentType?: string) => {
    await reauthorize();
    const response = await fetch(url, { method, ...(method === 'GET' ? {} : { body }), signal, redirect: 'manual',
      headers: { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}`, ...(contentType ? { 'content-type': contentType } : {}) } });
    if (!response.ok) { void response.body?.cancel().catch(() => {}); return denied(); }
    const data = JSON.parse(new TextDecoder().decode(await readBoundedResponse(response, 256 * 1024, 'Dispatcher deployment', signal)));
    if (data?.success !== true || !data.result) return denied();
    await reauthorize();
    return data.result;
  };
  const metadata = {
    main_module: bundle.mainModule, compatibility_date: bundle.compatibilityDate, compatibility_flags: bundle.compatibilityFlags,
    migrations: { new_tag: bundle.hosting.migrationTag, new_sqlite_classes: [bundle.hosting.className] },
    bindings: [
      { name: bundle.hosting.binding, type: 'durable_object_namespace', class_name: bundle.hosting.className },
      { name: 'OPERATOR', type: 'service', service: parentName, entrypoint: 'OperatorInstalledDispatcherCapability' },
      { name: 'CF_VERSION_METADATA', type: 'version_metadata' },
      { name: 'OPERATOR_CONNECTION_SECRET', type: 'secret_text', text: connectionSecret },
      ...Object.entries({ OPERATOR_INSTALLATION_ID: pin.installationId, OPERATOR_RELEASE_ID: pin.releaseId,
        OPERATOR_CONNECTION_REVISION: String(pin.connectionRevision), OPERATOR_SUBMISSION_ATTEMPT_LIMIT: String(admittedSubmissionAttemptLimit) })
        .map(([name, text]) => ({ name, type: 'plain_text', text })),
    ],
  };
  const form = new FormData();
  form.set('metadata', new Blob([JSON.stringify(metadata)], { type: 'application/json' }), 'metadata.json');
  for (const [name, module] of Object.entries(bundle.modules)) {
    form.set(name, new Blob(['js' in module ? module.js : module.text],
      { type: 'js' in module ? 'application/javascript+module' : 'text/plain' }), name);
  }
  await json(base, 'PUT', form);
  // Script upload has no documented version UUID receipt. Pin the concrete active deployment.
  const deployments = await json(`${base}/deployments`, 'GET');
  const latest = deployments.deployments?.[0];
  const version = latest?.versions?.[0];
  if (latest?.versions?.length !== 1 || version?.percentage !== 100
    || typeof version.version_id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(version.version_id)) return denied();
  await json(`${base}/subdomain`, 'POST', JSON.stringify({ enabled: true, previews_enabled: false }), 'application/json');
  const connection: DispatcherConnectionMetadata = { ...pin, workerName, workerVersionId: version.version_id };
  const verification = await verifyDispatcherDeployment(env, connection, bytes, admittedSubmissionAttemptLimit, reauthorize);
  return { connection, connectionSecret, verification };
}

/** Called only after human management authorization. GETs are bounded; no deployment is mutated. */
export async function verifyDispatcherDeployment(env: Env, connection: DispatcherConnectionMetadata,
  bytes: Uint8Array, admittedSubmissionAttemptLimit: number, reauthorize?: () => Promise<void>): Promise<DispatcherDeploymentVerification> {
  if (!Number.isSafeInteger(admittedSubmissionAttemptLimit) || admittedSubmissionAttemptLimit < 1) return denied();
  const bundle = await parseDispatcherBundle(bytes, connection.bundleDigest);
  const hosting = bundle.hosting;
  if (bundle.schemaVersion !== 2 || !hosting || bundle.sourceCommit !== connection.sourceCommit) return denied();
  // deploy.yml passes the same resolved name to --name and this runtime variable.
  // Missing deployment identity is not evidence that this parent is named codeflare.
  const parentName = env.CLOUDFLARE_WORKER_NAME;
  if (typeof parentName !== 'string' || !/^[a-z0-9_][a-z0-9_-]*$/.test(parentName)) return denied();
  const account = await env.KV.get(SETUP_KEYS.ACCOUNT_ID);
  if (!account || !/^[a-f0-9]{32}$/.test(account) || !env.CLOUDFLARE_API_TOKEN) return denied();
  const signal = AbortSignal.timeout(15000);
  const headers = { authorization: `Bearer ${env.CLOUDFLARE_API_TOKEN}` };
  const workers = `${CF_API_BASE}/accounts/${account}/workers`;
  const base = `${workers}/scripts/${connection.workerName}`;
  const json = async (url: string, limit = 256 * 1024) => {
    await reauthorize?.();
    const response = await fetch(url, { headers, signal, redirect: 'manual' });
    if (!response.ok) { void response.body?.cancel().catch(() => {}); denied(); }
    const data = JSON.parse(new TextDecoder().decode(await readBoundedResponse(response, limit, 'Dispatcher deployment', signal)));
    if (data?.success !== true || !data.result) return denied();
    await reauthorize?.();
    return data.result;
  };
  const active = async () => {
    const data = await json(`${base}/deployments`);
    const latest = data.deployments?.[0];
    if (latest?.versions?.length !== 1 || latest.versions[0].version_id !== connection.workerVersionId
      || latest.versions[0].percentage !== 100 || typeof latest.id !== 'string' || !latest.id) return denied();
    return latest.id as string;
  };
  const deployment = await active();
  // The version-addressed API explicitly includes source bytes AND module kinds.
  // No public contract links content/v2's unqualified ETag to this active version.
  const version = await json(`${workers}/workers/${connection.workerName}/versions/${connection.workerVersionId}?include=modules`, 16 * 1024 * 1024);
  if (version.id !== connection.workerVersionId || version.main_module !== bundle.mainModule) return denied();
  const bindings = version.bindings;
  if (!Array.isArray(bindings)) return denied();
  const names = new Set<string>();
  for (const item of bindings) {
    if (!item || typeof item.name !== 'string' || names.has(item.name)) return denied();
    names.add(item.name);
  }
  const binding = (name: string) => bindings.find((item: { name: string }) => item.name === name);
  for (const [name, expected] of Object.entries({ OPERATOR_INSTALLATION_ID: connection.installationId,
    OPERATOR_RELEASE_ID: connection.releaseId, OPERATOR_CONNECTION_REVISION: String(connection.connectionRevision) })) {
    if (binding(name)?.type !== 'plain_text' || binding(name)?.text !== expected) return denied();
  }
  // Flue 2.3 fixes maxAttempts at installation scope; admission must match that definition.
  const installedSubmissionLimit = binding('OPERATOR_SUBMISSION_ATTEMPT_LIMIT');
  if (installedSubmissionLimit === undefined
    ? admittedSubmissionAttemptLimit !== DEFAULT_SUBMISSION_ATTEMPT_LIMIT
    : installedSubmissionLimit.type !== 'plain_text' || installedSubmissionLimit.text !== String(admittedSubmissionAttemptLimit)) return denied();
  const namespace = binding('FLUE_DISPATCHER_AGENT');
  if (namespace?.type !== 'durable_object_namespace' || namespace.class_name !== undefined && namespace.class_name !== hosting.className
    || namespace.namespace_id === undefined && namespace.class_name !== hosting.className
    || namespace.script_name !== undefined && namespace.script_name !== connection.workerName
    || namespace.dispatch_namespace !== undefined) return denied();
  const parent = binding('OPERATOR');
  if (parent?.type !== 'service' || parent.entrypoint !== 'OperatorInstalledDispatcherCapability'
    || parent.service !== parentName) return denied();
  // Wrangler resolves a normal Worker name through this service's default environment.
  // Do not silently accept a binding to a different (legacy service) environment.
  const defaultEnvironment = async (name: string): Promise<string> => {
    const service = await json(`${workers}/services/${encodeURIComponent(name)}`);
    const environment = service.default_environment?.environment;
    if (typeof environment !== 'string' || !environment) return denied();
    return environment;
  };
  const parentEnvironment = await defaultEnvironment(parentName);
  if (parent.environment !== undefined && parent.environment !== parentEnvironment) return denied();
  if (namespace.environment !== undefined && namespace.environment !== await defaultEnvironment(connection.workerName)) return denied();
  if (binding('CF_VERSION_METADATA')?.type !== 'version_metadata'
    || binding('OPERATOR_CONNECTION_SECRET')?.type !== 'secret_text') return denied();
  if (version.compatibility_date !== bundle.compatibilityDate
    || !Array.isArray(version.compatibility_flags)
    || !version.compatibility_flags.every((flag: unknown) => typeof flag === 'string')
    || JSON.stringify([...version.compatibility_flags].sort()) !== JSON.stringify([...bundle.compatibilityFlags].sort())
    || version.migration_tag !== hosting.migrationTag) return denied();
  // A migration tag/class label alone does not establish the namespace's storage backend.
  // Namespace inventory exposes the actual script/class/SQLite association. Follow pages,
  // including when the binding does not echo its optional namespace_id field.
  for (let page = 1; ; page++) {
    const namespaces = await json(`${workers}/durable_objects/namespaces?page=${page}&per_page=100`);
    if (!Array.isArray(namespaces) || namespaces.length === 0) return denied();
    const found = namespaces.find((item: { id?: string; script?: string; class?: string; preview?: unknown; dispatch_namespace?: unknown } | null) => item
      && (namespace.namespace_id === undefined
        ? item.script === connection.workerName && item.class === hosting.className
          && item.preview === undefined && item.dispatch_namespace === undefined
        : item.id === namespace.namespace_id));
    if (!found) continue;
    if (typeof found.id !== 'string' || !found.id || found.script !== connection.workerName
      || found.class !== hosting.className || found.use_sqlite !== true
      || found.preview !== undefined || found.dispatch_namespace !== undefined) return denied();
    break;
  }
  if (!Array.isArray(version.modules) || version.modules.length !== Object.keys(bundle.modules).length) return denied();
  const modules = new Set<string>();
  for (const module of version.modules) {
    if (!module || typeof module.name !== 'string' || !Object.hasOwn(bundle.modules, module.name)
      || modules.has(module.name) || typeof module.content_base64 !== 'string') return denied();
    modules.add(module.name);
    const expected = bundle.modules[module.name];
    if ('js' in expected
      ? !['application/javascript+module', 'text/javascript+module'].includes(module.content_type)
      : module.content_type !== 'text/plain') return denied();
    let actual = '';
    try { actual = atob(module.content_base64); } catch { denied(); }
    const expectedBytes = new TextEncoder().encode('js' in expected ? expected.js : expected.text);
    if (actual.length !== expectedBytes.length || expectedBytes.some((byte, i) => byte !== actual.charCodeAt(i))) return denied();
  }
  const subdomain = await json(`${workers}/subdomain`);
  if (typeof subdomain.subdomain !== 'string' || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(subdomain.subdomain)) return denied();
  const workerSubdomain = await json(`${base}/subdomain`);
  if (workerSubdomain.enabled !== true) return denied();
  if (await active() !== deployment) return denied();
  return { connectionRevision: connection.connectionRevision, workerVersionId: connection.workerVersionId,
    bundleDigest: connection.bundleDigest, controlOrigin: `https://${connection.workerName}.${subdomain.subdomain}.workers.dev` };
}
