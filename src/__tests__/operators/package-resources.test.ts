import { describe, expect, it } from 'vitest';
import { parseOperatorBundle } from '../../operators/distribution';
import { projectOperatorPackageResources, verifyOperatorPackageResourceProjection } from '../../operators/package-resources';

async function sha(value: string | Uint8Array) {
  const bytes = typeof value === 'string' ? new TextEncoder().encode(value) : value;
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

async function bundle(resources: unknown = undefined) {
  const text = 'approved package resource\n';
  const value = { schemaVersion: 1, interfaceVersion: 1, compatibilityDate: '2026-02-05',
    compatibilityFlags: ['nodejs_compat'], mainModule: 'worker.js', modules: {
      'worker.js': { js: 'export default {}' }, 'package/config.md': { text },
    }, ...(resources === undefined ? {} : { resources }) };
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  return { parsed: await parseOperatorBundle(bytes, await sha(bytes)), digest: await sha(bytes), text };
}

describe('generic admitted Operator package resources', () => {
  it('projects only package-declared destinations and exact digest/size-bound bytes', async () => {
    const text = 'approved package resource\n';
    const fixture = await bundle({ schemaVersion: 1, files: [{ source: 'package/config.md',
      destination: 'review/config.md', sha256: await sha(text),
      size: new TextEncoder().encode(text).byteLength }] });
    const projection = await projectOperatorPackageResources(fixture.parsed, fixture.digest);
    expect(projection).toEqual({ schemaVersion: 1, artifactDigest: fixture.digest, files: [{
      destination: 'review/config.md', sha256: await sha(text),
      size: new TextEncoder().encode(text).byteLength, content: text,
    }] });
    expect(JSON.stringify(projection)).not.toMatch(/credential|authority|accessJwt|secret/i);
  });

  it('keeps bundles without resources compatible and rejects noncanonical, mismatched declarations', async () => {
    expect(await projectOperatorPackageResources((await bundle()).parsed, (await bundle()).digest)).toBeNull();
    for (const declared of [
      { source: 'package/config.md', destination: '/absolute/path', sha256: await sha('approved package resource\n'), size: 26 },
      { source: 'package/config.md', destination: 'review/../escape', sha256: await sha('approved package resource\n'), size: 26 },
      { source: 'package/config.md', destination: 'review/config', sha256: '0'.repeat(64), size: 26 },
      { source: 'package/config.md', destination: 'review/config', sha256: await sha('approved package resource\n'), size: 1 },
    ]) {
      await expect(bundle({ schemaVersion: 1, files: [declared] }).then(value =>
        projectOperatorPackageResources(value.parsed, value.digest))).rejects.toThrow();
    }
  });

  it('revalidates persisted projections before trusted restore', async () => {
    const content = 'resource';
    await expect(verifyOperatorPackageResourceProjection({ schemaVersion: 1, artifactDigest: 'a'.repeat(64),
      files: [{ destination: 'review/resource', content, size: content.length, sha256: 'b'.repeat(64) }],
    })).rejects.toThrow(/resource projection/i);
  });
});
