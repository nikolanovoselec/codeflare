import { describe, expect, it } from 'vitest';
import { parseOperatorBundle, parseOperatorManifest } from '../../operators/distribution';
import {
  GATE1_BUNDLE_BYTES,
  GATE1_MANIFEST_PATH,
  GATE1_ARTIFACT_PATH,
} from '../../../fixtures/operator-gate1/src/bundle';
import { handleGate1FixtureRequest } from '../../../fixtures/operator-gate1/src/index';

const origin = 'https://operator-gate1.enterprise.example.test';
const secret = 'gate1-connection-secret-with-at-least-32-bytes';
const env = { GATE1_OPERATOR_CONNECTION_SECRET: secret };

function request(path: string, init: RequestInit = {}): Request {
  const headers = new Headers(init.headers);
  headers.set('cf-access-jwt-assertion', 'verified-human-access-jwt');
  headers.set('authorization', `Bearer ${secret}`);
  return new Request(`${origin}${path}`, { ...init, headers });
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

describe('REQ-OPERATOR-009: live Gate 1 fixture distribution', () => {
  it.each([
    ['human Access assertion', request(GATE1_MANIFEST_PATH, {
      headers: { authorization: `Bearer ${secret}` },
    })],
    ['connection secret', request(GATE1_MANIFEST_PATH, {
      headers: { 'cf-access-jwt-assertion': 'verified-human-access-jwt' },
    })],
    ['correct connection secret', request(GATE1_MANIFEST_PATH, {
      headers: {
        'cf-access-jwt-assertion': 'verified-human-access-jwt',
        authorization: 'Bearer wrong-connection-secret-with-32-bytes',
      },
    })],
  ])('requires %s without reflecting credentials', async (_label, input) => {
    const response = await handleGate1FixtureRequest(input, env);
    expect(response.status).toBe(401);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.text();
    expect(body).not.toContain(secret);
    expect(body).not.toContain('verified-human-access-jwt');
  });

  it('fails closed when its dedicated secret is absent or malformed', async () => {
    for (const configured of [undefined, '', 'too-short']) {
      const response = await handleGate1FixtureRequest(request(GATE1_MANIFEST_PATH), {
        GATE1_OPERATOR_CONNECTION_SECRET: configured,
      });
      expect(response.status).toBe(503);
    }
  });

  it.each([
    ['POST', GATE1_MANIFEST_PATH, 405],
    ['GET', `${GATE1_MANIFEST_PATH}?secret=query`, 404],
    ['GET', '/unknown', 404],
  ])('rejects unsupported %s %s', async (method, path, status) => {
    expect((await handleGate1FixtureRequest(request(path, { method }), env)).status).toBe(status);
  });

  it('serves one deterministic compatible manifest and exact digest-pinned bundle', async () => {
    const manifestResponse = await handleGate1FixtureRequest(request(GATE1_MANIFEST_PATH), env);
    expect(manifestResponse.status).toBe(200);
    expect(manifestResponse.headers.get('content-type')).toBe('application/json');
    expect(manifestResponse.headers.get('cache-control')).toBe('no-store');
    expect(manifestResponse.headers.get('x-content-type-options')).toBe('nosniff');
    const manifestJson = await manifestResponse.text();
    const manifest = parseOperatorManifest(manifestJson, `${origin}${GATE1_MANIFEST_PATH}`);
    expect(manifest).toMatchObject({
      id: 'codeflare-gate1-fixture',
      interfaceVersion: 1,
      requiredCapabilities: ['session', 'pi', 'storage', 'inference'],
      artifact: { path: GATE1_ARTIFACT_PATH },
    });

    const bundleResponse = await handleGate1FixtureRequest(request(GATE1_ARTIFACT_PATH), env);
    expect(bundleResponse.status).toBe(200);
    expect(bundleResponse.headers.get('content-type')).toBe('application/json');
    expect(bundleResponse.headers.get('cache-control')).toBe('no-store');
    const received = new Uint8Array(await bundleResponse.arrayBuffer());
    expect(received).toEqual(GATE1_BUNDLE_BYTES);
    expect(await sha256(received)).toBe(manifest.artifact.sha256);
    expect(await parseOperatorBundle(received, manifest.artifact.sha256)).toMatchObject({
      schemaVersion: 1,
      interfaceVersion: 1,
      mainModule: 'index.js',
    });
  });
});
