import { beforeAll, describe, expect, it } from 'vitest';
import { verifyBoundaryActionOidc } from '../../operators/boundary-action-oidc';

const sha = 'a'.repeat(40);
const expected = {
  audience: 'https://enterprise.example.test/operator-webhook/v1/activities/claims/boundary',
  repositoryId: 138, repository: 'owner/repo',
  workflowPath: '.github/workflows/boundary-reviews.yml', protectedRef: 'refs/heads/main',
  workflowSha: sha, runId: 502, runAttempt: 2,
};
const workflowRef = `owner/repo/${expected.workflowPath}@${expected.protectedRef}`;
const encode = (value: unknown) => btoa(String.fromCharCode(...new TextEncoder().encode(JSON.stringify(value))))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

let privateKey: CryptoKey;
let fetchKeys: () => Promise<unknown>;

async function token(claims: Record<string, unknown> = {}, header: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: 'https://token.actions.githubusercontent.com', aud: expected.audience,
    iat: now - 10, nbf: now - 10, exp: now + 300,
    repository_id: '138', repository: 'owner/repo', event_name: 'pull_request_target',
    workflow_ref: workflowRef, workflow_sha: sha, run_id: '502', run_attempt: '2',
    sub: 'repo:owner/repo:ref:refs/heads/main', ...claims,
  };
  const input = `${encode({ alg: 'RS256', typ: 'JWT', kid: 'boundary-key', ...header })}.${encode(payload)}`;
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', privateKey, new TextEncoder().encode(input));
  return `${input}.${btoa(String.fromCharCode(...new Uint8Array(signature))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
}

beforeAll(async () => {
  const keys = await crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true, ['sign', 'verify'],
  );
  privateKey = keys.privateKey;
  const publicJwk = await crypto.subtle.exportKey('jwk', keys.publicKey);
  fetchKeys = async () => ({ keys: [{ ...publicJwk, kid: 'boundary-key', use: 'sig', alg: 'RS256' }] });
});

describe('REQ-OPERATOR-053: trusted Action OIDC run identity', () => {
  it('accepts a signed target workflow on the pinned protected revision and returns verified identity', async () => {
    expect(await verifyBoundaryActionOidc(await token(), expected, fetchKeys)).toEqual({
      repositoryId: 138, repository: 'owner/repo', workflowRef, workflowSha: sha,
      runId: 502, runAttempt: 2, eventName: 'pull_request_target',
    });
  });

  it('rejects tampered signatures and unknown signing keys', async () => {
    const valid = await token();
    const [header, payload, signature] = valid.split('.');
    expect(await verifyBoundaryActionOidc(`${header}.${encode({ altered: true })}.${signature}`, expected, fetchKeys)).toBeNull();
    expect(await verifyBoundaryActionOidc(await token({}, { kid: 'unknown' }), expected, fetchKeys)).toBeNull();
  });

  it('rejects wrong issuer, audience, expired or not-yet-valid tokens', async () => {
    const now = Math.floor(Date.now() / 1000);
    for (const claims of [
      { iss: 'https://example.com' }, { aud: 'other' }, { exp: now - 10 },
      { nbf: now + 300 }, { iat: now + 300 },
    ]) {
      expect(await verifyBoundaryActionOidc(await token(claims), expected, fetchKeys)).toBeNull();
    }
  });

  it('rejects candidate pull_request jobs and incompatible token identity claims', async () => {
    for (const claims of [
      { event_name: 'pull_request' },
      { repository_id: '139' }, { repository: 'other/repo' },
      { workflow_ref: 'owner/repo/.github/workflows/other.yml@refs/heads/main' },
      { workflow_ref: `owner/repo/${expected.workflowPath}@refs/heads/candidate` },
      { workflow_sha: 'b'.repeat(40) }, { run_id: '503' }, { run_attempt: '3' },
    ]) {
      expect(await verifyBoundaryActionOidc(await token(claims), expected, fetchKeys)).toBeNull();
    }
  });

  it('rejects mismatched expected workflow context and malformed tokens', async () => {
    for (const mismatch of [
      { repositoryId: 139 }, { repository: 'other/repo' }, { workflowPath: '.github/workflows/other.yml' },
      { protectedRef: 'refs/heads/feature' }, { workflowSha: 'b'.repeat(40) },
      { runId: 503 }, { runAttempt: 3 }, { audience: 'other' },
    ]) {
      expect(await verifyBoundaryActionOidc(await token(), { ...expected, ...mismatch }, fetchKeys)).toBeNull();
    }
    for (const malformed of ['', 'abc', 'a.b.c', `${(await token()).split('.').slice(0, 2).join('.')}.invalid`]) {
      expect(await verifyBoundaryActionOidc(malformed, expected, fetchKeys)).toBeNull();
    }
  });
});
