/// <reference types="@cloudflare/vitest-pool-workers/types" />
/**
 * Test navigation: Approval/admission snapshot immutability across replacement and reconstruction; manifests cross RPC as validated JSON text.
 * Fixtures are local/CI evidence, not production deployment or live Access acceptance.
 * Requirement IDs in describe blocks link each behavior to sdd/spec/operators.md.
 */
import { describe, expect, it } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { OperatorRegistry } from '../../operators/registry';
import { parseOperatorManifest } from '../../operators/distribution';
import { ValidationError } from '../../lib/error-types';

const endpoint = 'https://operator.example.test/discovery';
const protectedEnv = { ENCRYPTION_KEY: btoa('k'.repeat(32)) };
const policyJson = JSON.stringify({ schemaVersion: 1, networkHosts: [], github: { repositories: [], methods: [] },
  storage: { readPrefixes: [], writePrefixes: [] }, inference: { routeIds: [], defaultRouteId: null,
    reasoningLevels: [], defaultReasoningLevel: null, inheritUserDefaults: false } });
function manifest(version = '1') {
  return parseOperatorManifest(JSON.stringify({ schemaVersion: 1, interfaceVersion: 1, id: 'operator',
    name: 'Example', description: 'Approved intent', coreVersion: version, intentVersion: version,
    inputSchema: { type: 'object' }, requiredCapabilities: ['storage'],
    artifact: { path: '/bundle.json', sha256: (version === '1' ? 'a' : 'b').repeat(64) },
  }), endpoint);
}
async function withRegistry(test: (registry: OperatorRegistry, ctx: DurableObjectState) => Promise<void>) {
  const namespace = (env as unknown as { TIMEKEEPER: DurableObjectNamespace }).TIMEKEEPER;
  await runInDurableObject(namespace.get(namespace.newUniqueId()), async (_instance, ctx) => {
    const registry = new OperatorRegistry(ctx, protectedEnv);
    await registry.create('operator');
    await registry.setDistribution('operator', endpoint, 'connection', 1);
    await test(registry, ctx);
  });
}

describe('REQ-OPERATOR-011: approved manifest snapshots', () => {
  it('persists full compatible metadata without enabling the registration', () => withRegistry(async (registry, ctx) => {
    expect(await registry.getApprovedManifest('operator')).toBeNull();
    expect(await registry.approveManifest('operator', JSON.stringify(manifest()), 2)).toEqual({ ok: true, value: {
      operatorId: 'operator', revision: 3, enabled: false, approvedArtifactDigest: 'a'.repeat(64),
    } });
    expect(await new OperatorRegistry(ctx, protectedEnv).getApprovedManifest('operator')).toEqual(JSON.stringify(manifest()));
    expect(await registry.getApprovedManifest('missing')).toBeNull();
  }));

  it('resolves only a complete enabled execution selection and pins protected distribution at admission', () => withRegistry(async registry => {
    expect(await registry.resolveForExecution('operator')).toEqual({ ok: false, reason: 'disabled' });
    await registry.setPolicy('operator', policyJson, 2);
    await registry.approveManifest('operator', JSON.stringify(manifest()), 3);
    await registry.setEnabled('operator', true, 4);
    expect(await registry.resolveForExecution('operator')).toEqual({ ok: true, value: {
      operatorId: 'operator', revision: 5, artifactDigest: 'a'.repeat(64), manifestJson: JSON.stringify(manifest()), policyJson,
    } });
    const request = { operatorId: 'operator', activityId: 'activity-pinned', intentDigest: 'd'.repeat(64),
      expectedRevision: 5, deadline: Date.now() + 60_000 };
    const admitted = await registry.admit(request);
    expect(admitted).toMatchObject({ ok: true, value: { activityId: 'activity-pinned' } });
    const pinned = await registry.getPinnedDistribution('activity-pinned');
    expect(pinned).toEqual(await registry.getProtectedDistribution('operator'));
    expect(JSON.stringify(admitted)).not.toContain(pinned!.connectionSecretCiphertext);
  }));

  it('pins admitted metadata through replacement approval and distribution changes', () => withRegistry(async registry => {
    await registry.setPolicy('operator', policyJson, 2);
    await registry.approveManifest('operator', JSON.stringify(manifest()), 3);
    await registry.setEnabled('operator', true, 4);
    const request = { operatorId: 'operator', activityId: 'activity', intentDigest: 'c'.repeat(64), expectedRevision: 5, deadline: Date.now() + 60_000 };
    const admitted = await registry.admit(request);
    expect(admitted).toMatchObject({ ok: true, value: { manifestJson: JSON.stringify(manifest()), artifactDigest: 'a'.repeat(64) } });
    expect(await registry.approveManifest('operator', JSON.stringify(manifest('2')), 5)).toMatchObject({ ok: true, value: { revision: 6, enabled: false } });
    expect(await registry.getApprovedManifest('operator')).toEqual(JSON.stringify(manifest('2')));
    expect(await registry.admit(request)).toEqual(admitted);
    await registry.setDistribution('operator', 'https://replacement.example.test/', 'replacement', 6);
    expect(await registry.getApprovedManifest('operator')).toBeNull();
    expect(await registry.getReceipt('activity')).toEqual(admitted);
  }));

  it('rejects stale approval and mismatched identity or derived URL without changing approved metadata', () => withRegistry(async registry => {
    await registry.approveManifest('operator', JSON.stringify(manifest()), 2);
    expect(await registry.approveManifest('operator', JSON.stringify(manifest('2')), 2)).toEqual({ ok: false, reason: 'revision-conflict' });
    expect(await registry.approveManifest('missing', JSON.stringify(manifest()), 1)).toEqual({ ok: false, reason: 'not-found' });
    for (const invalid of [
      { ...manifest(), id: 'other' },
      { ...manifest(), artifact: { ...manifest().artifact, url: 'https://other.example.test/bundle.json' } },
    ]) {
      await expect(registry.approveManifest('operator', JSON.stringify(invalid), 3)).rejects.toBeInstanceOf(ValidationError);
    }
    expect(await registry.getApprovedManifest('operator')).toEqual(JSON.stringify(manifest()));
  }));

  it('rejects approval without configured distribution', () => withRegistry(async registry => {
    await registry.create('unconfigured');
    await expect(registry.approveManifest('unconfigured', JSON.stringify({ ...manifest(), id: 'unconfigured' }), 1))
      .rejects.toBeInstanceOf(ValidationError);
    expect(await registry.getApprovedManifest('unconfigured')).toBeNull();
  }));

  it('does not leave mismatched metadata attached to a subsequent digest-only approval', () => withRegistry(async registry => {
    await registry.approveManifest('operator', JSON.stringify(manifest()), 2);
    await registry.approve('operator', 'b'.repeat(64), 3);
    expect(await registry.getApprovedManifest('operator')).toBeNull();
  }));
});
