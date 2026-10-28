/** Stateful public Cloudflare HTTP boundary. Stores uploaded wire bytes; never executes an SDK/Worker. */
type UploadMetadata = {
  main_module: string; compatibility_date: string; compatibility_flags: string[];
  bindings: Array<{ name: string; type: string; text?: string; class_name?: string; service?: string; entrypoint?: string; [key: string]: unknown }>;
  migrations?: { new_tag: string; new_sqlite_classes?: string[]; [key: string]: unknown };
  [key: string]: unknown;
};
export type UploadedDispatcher = {
  name: string; versionId: string; deploymentId: string; namespaceId: string;
  metadata: UploadMetadata; modules: Array<{ name: string; type: string; bytes: number[] }>;
  subdomainEnabled: boolean; subdomainRequest?: { enabled?: boolean; previews_enabled?: boolean };
};
export type DispatcherPlatformFault = 'none' | 'upload-denied' | 'upload-uncertain' | 'active-version-missing'
  | 'subdomain-denied' | 'changed-module' | 'foreign-parent' | 'non-sqlite' | 'active-version-drift'
  | 'version-unavailable' | 'wrong-installation' | 'wrong-limit';

export function createDispatcherCloudflareFixture() {
  const accountId = 'a'.repeat(32);
  const token = 'synthetic-platform-token';
  const parentName = 'codeflare-integration';
  const workers = `/client/v4/accounts/${accountId}/workers`;
  const scripts = new Map<string, UploadedDispatcher>();
  const uploads: UploadedDispatcher[] = [];
  // This is an external protected-write ledger, not an internal helper spy.
  const writes: Array<{ method: string; path: string }> = [];
  const unexpected: string[] = [];
  let fault: DispatcherPlatformFault = 'none';
  let afterUpload: ((script: UploadedDispatcher) => Promise<void>) | undefined;
  let beforeVersionRead: (() => Promise<void>) | undefined;
  const ok = (result: unknown) => Response.json({ success: true, errors: [], messages: [], result });
  const missing = () => Response.json({ success: false, errors: [{ code: 10007, message: 'Worker not found' }], result: null }, { status: 404 });
  const fail = () => Response.json({ success: false, errors: [{ code: 10000, message: 'Platform refused synthetic-platform-token acquisition-only-pat' }], result: null }, { status: 403 });
  const fetcher = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (url.origin !== 'https://api.cloudflare.com' || request.headers.get('authorization') !== `Bearer ${token}`)
      return fail();
    if (request.method !== 'GET') writes.push({ method: request.method, path: url.pathname });
    if (url.pathname === `${workers}/subdomain` && request.method === 'GET') return ok({ subdomain: 'platform-account' });
    if (url.pathname === `${workers}/durable_objects/namespaces` && request.method === 'GET') {
      const result = Number(url.searchParams.get('page') ?? '1') === 1 ? [...scripts.values()].map(script => ({
        id: script.namespaceId, name: `${script.name}_FlueDispatcherAgent`, class: 'FlueDispatcherAgent',
        script: script.name, use_sqlite: fault !== 'non-sqlite',
      })) : [];
      return Response.json({ success: true, errors: [], messages: [], result,
        result_info: { page: 1, per_page: 100, count: result.length, total_count: scripts.size, total_pages: 1 } });
    }
    const service = url.pathname.match(new RegExp(`^${workers}/services/([a-z0-9_-]+)$`));
    if (service && request.method === 'GET' && (service[1] === parentName || scripts.has(service[1]!)))
      return ok({ id: service[1], default_environment: { environment: 'production', script: { id: service[1] } } });
    const scriptRoute = url.pathname.match(new RegExp(`^${workers}/scripts/([a-z0-9_-]+)(/deployments|/subdomain)?$`));
    if (scriptRoute) {
      const name = scriptRoute[1]!;
      const suffix = scriptRoute[2] ?? '';
      if (!suffix && request.method === 'PUT') {
        if (fault === 'upload-denied') return fail();
        const form = await request.formData();
        const metadataPart = form.get('metadata');
        if (metadataPart === null) return Response.json({ success: false }, { status: 400 });
        const metadata = JSON.parse(typeof metadataPart === 'string' ? metadataPart : await metadataPart.text()) as UploadMetadata;
        const modules: UploadedDispatcher['modules'] = [];
        for (const [partName, value] of form) {
          if (partName === 'metadata') continue;
          if (typeof value === 'string') return Response.json({ success: false }, { status: 400 });
          modules.push({ name: partName, type: value.type, bytes: [...new Uint8Array(await value.arrayBuffer())] });
        }
        const script: UploadedDispatcher = { name, metadata, modules, versionId: crypto.randomUUID(),
          deploymentId: crypto.randomUUID(), namespaceId: crypto.randomUUID().replaceAll('-', ''), subdomainEnabled: false };
        scripts.set(name, script); uploads.push(structuredClone(script));
        if (afterUpload) await afterUpload(script);
        if (fault === 'upload-uncertain') throw new Error('Upload acknowledgement lost after platform acceptance synthetic-platform-token');
        // ScriptUpdateResponse has no documented version UUID. Production must read /deployments.
        return ok({ id: name, etag: 'opaque-upload-etag', startup_time_ms: 1, handlers: ['fetch'],
          named_handlers: ['FlueDispatcherAgent'] });
      }
      const script = scripts.get(name);
      if (!script) return missing();
      if (suffix === '/subdomain') {
        if (request.method === 'POST') {
          if (fault === 'subdomain-denied') return fail();
          const body = await request.json() as { enabled?: boolean; previews_enabled?: boolean };
          script.subdomainRequest = body;
          script.subdomainEnabled = body.enabled === true;
          return ok({ enabled: script.subdomainEnabled, previews_enabled: false });
        }
        if (request.method === 'GET') return ok({ enabled: script.subdomainEnabled, previews_enabled: false });
      }
      if (suffix === '/deployments' && request.method === 'GET') return ok({ deployments: fault === 'active-version-missing' ? [] : [{ id: script.deploymentId,
        versions: [{ version_id: script.versionId, percentage: 100 }] }] });
      if (!suffix && request.method === 'GET') return ok({ id: name, startup_time_ms: 1 });
    }
    const versionRoute = url.pathname.match(new RegExp(`^${workers}/workers/([a-z0-9_-]+)/versions/([a-f0-9-]+)$`));
    if (versionRoute && request.method === 'GET') {
      const script = scripts.get(versionRoute[1]!);
      if (!script || script.versionId !== versionRoute[2]) return missing();
      if (beforeVersionRead) { const hook = beforeVersionRead; beforeVersionRead = undefined; await hook(); }
      if (fault === 'version-unavailable') return fail();
      const bindings = structuredClone(script.metadata.bindings).map(binding => {
        if (binding.type === 'durable_object_namespace') return { ...binding, namespace_id: script.namespaceId };
        // Cloudflare does not echo secret values on reads.
        if (binding.type === 'secret_text') { const { text: _secret, ...publicBinding } = binding; return publicBinding; }
        return binding;
      });
      for (const binding of bindings) {
        if (fault === 'foreign-parent' && binding.name === 'OPERATOR') binding.service = 'foreign-parent';
        if (fault === 'wrong-installation' && binding.name === 'OPERATOR_INSTALLATION_ID') binding.text = 'foreign-installation';
        if (fault === 'wrong-limit' && binding.name === 'OPERATOR_SUBMISSION_ATTEMPT_LIMIT') binding.text = '999';
      }
      const modules = script.modules.map((module, index) => ({ name: module.name, content_type: module.type,
        content_base64: btoa(String.fromCharCode(...module.bytes) + (fault === 'changed-module' && index === 0 ? '\nchanged' : '')) }));
      if (fault === 'active-version-drift') script.deploymentId = 'replacement-active-deployment';
      return ok({ id: script.versionId, number: 1, created_on: '2026-10-28T00:00:00Z', urls: [], bindings,
        main_module: script.metadata.main_module, compatibility_date: script.metadata.compatibility_date,
        compatibility_flags: script.metadata.compatibility_flags, migration_tag: script.metadata.migrations?.new_tag,
        ...(url.searchParams.get('include') === 'modules' ? { modules } : {}) });
    }
    unexpected.push(`${request.method} ${url.pathname}`);
    return Response.json({ success: false, errors: [{ code: 10007, message: 'Unexpected fixture endpoint' }] }, { status: 404 });
  };
  return { accountId, token, parentName, scripts, uploads, writes, unexpected, fetcher,
    setFault: (value: DispatcherPlatformFault) => { fault = value; },
    afterUpload: (hook: (script: UploadedDispatcher) => Promise<void>) => { afterUpload = hook; },
    beforeVersionRead: (hook: () => Promise<void>) => { beforeVersionRead = hook; } };
}
