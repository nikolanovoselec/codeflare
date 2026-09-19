import {
  GATE1_ARTIFACT_PATH,
  GATE1_BUNDLE_BYTES,
  GATE1_BUNDLE_JSON,
  GATE1_MANIFEST_PATH,
} from './bundle';

interface Gate1FixtureEnv {
  GATE1_OPERATOR_CONNECTION_SECRET?: string;
}

const encoder = new TextEncoder();
const JSON_HEADERS = {
  'content-type': 'application/json',
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

function json(value: unknown, status: number): Response {
  return new Response(JSON.stringify(value), { status, headers: JSON_HEADERS });
}

async function hash(value: string | Uint8Array): Promise<Uint8Array> {
  const bytes = typeof value === 'string' ? encoder.encode(value) : value;
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

async function equalSecret(provided: string, expected: string): Promise<boolean> {
  const [left, right] = await Promise.all([hash(provided), hash(expected)]);
  let difference = 0;
  for (let index = 0; index < left.byteLength; index++) difference |= left[index] ^ right[index];
  return difference === 0;
}

function bearer(request: Request): string | null {
  const value = request.headers.get('authorization');
  if (!value?.startsWith('Bearer ')) return null;
  const token = value.slice(7);
  return token && token.length <= 1024 ? token : null;
}

async function manifestJson(): Promise<string> {
  const digest = Array.from(await hash(GATE1_BUNDLE_BYTES))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
  return JSON.stringify({
    schemaVersion: 1,
    interfaceVersion: 1,
    id: 'codeflare-gate1-fixture',
    name: 'Codeflare Gate 1 fixture',
    description: 'Deterministic non-production Phase-1 acceptance fixture',
    coreVersion: 'gate1-v1',
    intentVersion: 'gate1-v1',
    inputSchema: { type: 'object' },
    requiredCapabilities: ['session', 'pi', 'storage', 'inference'],
    artifact: { path: GATE1_ARTIFACT_PATH, sha256: digest },
  });
}

/** Stateless enterprise-integration fixture boundary; Cloudflare Access validates the assertion at the edge. */
export async function handleGate1FixtureRequest(request: Request, env: Gate1FixtureEnv): Promise<Response> {
  const configuredSecret = env.GATE1_OPERATOR_CONNECTION_SECRET;
  if (!configuredSecret || encoder.encode(configuredSecret).byteLength < 32) {
    return json({ error: 'Fixture unavailable' }, 503);
  }

  const url = new URL(request.url);
  if (url.search || url.hash || (url.pathname !== GATE1_MANIFEST_PATH && url.pathname !== GATE1_ARTIFACT_PATH)) {
    return json({ error: 'Not found' }, 404);
  }
  if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

  const accessAssertion = request.headers.get('cf-access-jwt-assertion');
  const connectionSecret = bearer(request);
  if (!accessAssertion || encoder.encode(accessAssertion).byteLength > 64 * 1024 || !connectionSecret
    || !(await equalSecret(connectionSecret, configuredSecret))) {
    return json({ error: 'Unauthorized' }, 401);
  }

  if (url.pathname === GATE1_MANIFEST_PATH) {
    return new Response(await manifestJson(), { status: 200, headers: JSON_HEADERS });
  }
  return new Response(GATE1_BUNDLE_JSON, { status: 200, headers: JSON_HEADERS });
}

export default {
  fetch: handleGate1FixtureRequest,
} satisfies ExportedHandler<Gate1FixtureEnv>;
