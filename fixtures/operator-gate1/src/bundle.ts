export const GATE1_MANIFEST_PATH = '/.well-known/codeflare-operator.json';
export const GATE1_ARTIFACT_PATH = '/artifacts/gate1-v1.json';

const mainModule = `export default {
  async fetch(request, env) {
    if (request.method !== 'POST' || new URL(request.url).pathname !== '/drive') {
      return Response.json({ error: 'Not found' }, { status: 404 });
    }
    const drive = await request.json();
    const invocation = drive && typeof drive === 'object' ? drive.invocation : null;
    const resources = invocation && typeof invocation === 'object' ? invocation.resources : null;
    if (resources && typeof resources === 'object' && resources.session !== null) {
      const response = await env.OPERATOR.fetch(new Request('https://operator.invalid/v1/gate1/session', {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
          schemaVersion: 1, activityId: drive.activityId, generation: drive.generation,
          checkpoint: drive.checkpoint ?? null,
        }),
      }));
      if (response.status !== 200) return Response.json({ schemaVersion: 1, status: 'failed', checkpoint: null,
        result: { code: 'GATE1_CAPABILITY_REJECTED' } });
      const result = await response.json();
      if (!result || result.schemaVersion !== 1 || !['waiting', 'completed', 'failed'].includes(result.status)) {
        return Response.json({ schemaVersion: 1, status: 'failed', checkpoint: null,
          result: { code: 'GATE1_CAPABILITY_INVALID' } });
      }
      return Response.json(result);
    }
    return Response.json({ schemaVersion: 1, status: 'completed', checkpoint: null,
      result: { fixture: 'codeflare-gate1', activityId: drive.activityId } });
  },
};`;

const bundle = {
  schemaVersion: 1,
  interfaceVersion: 1,
  compatibilityDate: '2026-02-05',
  compatibilityFlags: ['nodejs_compat'],
  mainModule: 'index.js',
  modules: {
    'index.js': { js: mainModule },
  },
} as const;

export const GATE1_BUNDLE_JSON = JSON.stringify(bundle);
export const GATE1_BUNDLE_BYTES = new TextEncoder().encode(GATE1_BUNDLE_JSON);
