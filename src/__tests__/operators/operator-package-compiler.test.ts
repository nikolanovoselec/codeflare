import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { compileOperatorPackage } from '../../../scripts/operator-package/compiler.mjs';
import { parseDispatcherBundle, parseOperatorBundle, parseOperatorManifest } from '../../operators/distribution';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const manifest = (profile: 'conductor' | 'dispatcher' = 'conductor') => ({ schemaVersion: 1, interfaceVersion: 1,
  id: 'fixture', name: 'Fixture', description: '', coreVersion: '1', intentVersion: '1', profile,
  inputSchema: { type: 'object' }, outputSchema: { type: 'object' }, requiredCapabilities: [] });
const standard = () => ({ schemaVersion: 1, interfaceVersion: 1, compatibilityDate: '2026-02-05',
  compatibilityFlags: ['nodejs_compat'], mainModule: 'worker.js', modules: {
    'worker.js': { js: 'export default {}' }, 'resources/rules.txt': { text: 'exact bytes\n' },
  }, resources: { schemaVersion: 1, files: [{ source: 'resources/rules.txt', destination: 'review/rules.txt' }] } });
const dispatcher = (version = '2.1.0') => ({ schemaVersion: 1, sourceCommit: 'a'.repeat(40),
  versions: { runtime: version, vitePlugin: version, agents: '0.20.1' }, className: 'FlueDispatcherAgent',
  compatibilityDate: '2026-09-10', compatibilityFlags: ['nodejs_compat'], mainModule: 'dispatcher.js',
  modules: { 'dispatcher.js': { js: 'export class FlueDispatcherAgent {}' } } });

function bytes(result: Awaited<ReturnType<typeof compileOperatorPackage>>, name: string) {
  return result.files.get(name)!;
}

describe('shared operator package compiler', () => {
  it('deterministically emits the existing standard bundle and exact resource metadata', async () => {
    const input = { manifest: manifest(), bundle: standard() };
    const first = await compileOperatorPackage(input); const second = await compileOperatorPackage(input);
    expect([...first.files].map(([name, value]) => [name, Buffer.from(value).toString('hex')]))
      .toEqual([...second.files].map(([name, value]) => [name, Buffer.from(value).toString('hex')]));
    const parsedManifest = parseOperatorManifest(new TextDecoder().decode(bytes(first, 'operator-manifest.json')), 'https://operators.example.test/discovery');
    const parsed = await parseOperatorBundle(bytes(first, 'operator-bundle.json'), parsedManifest.artifact.sha256);
    expect(parsed.resources?.files[0]).toMatchObject({ size: 12, sha256: sha(new TextEncoder().encode('exact bytes\n')) });
  });

  it.each(['2.1.0', '2.2.2'])('emits the supported SDK %s bundle and provenance over exact emitted bytes', async version => {
    const result = await compileOperatorPackage({ manifest: manifest('dispatcher'), bundle: dispatcher(version), provenance: {
      repositoryId: 7, sourceCommit: 'a'.repeat(40), compilerCommit: 'b'.repeat(40), workflow: { id: 8, ref: 'refs/heads/main', runId: 9, runAttempt: 1 },
    } });
    const parsedManifest = parseOperatorManifest(new TextDecoder().decode(bytes(result, 'operator-manifest.json')), 'https://operators.example.test/');
    await expect(parseDispatcherBundle(bytes(result, 'operator-bundle.json'), parsedManifest.artifact.sha256)).resolves.toMatchObject({
      className: 'FlueDispatcherAgent', versions: { runtime: version, vitePlugin: version, agents: '0.20.1' },
    });
    const repeated = await compileOperatorPackage({ manifest: manifest('dispatcher'), bundle: dispatcher(version), provenance: {
      repositoryId: 7, sourceCommit: 'a'.repeat(40), compilerCommit: 'b'.repeat(40), workflow: { id: 8, ref: 'refs/heads/main', runId: 9, runAttempt: 1 },
    } });
    expect([...result.files].map(([name, value]) => [name, Buffer.from(value).toString('hex')]))
      .toEqual([...repeated.files].map(([name, value]) => [name, Buffer.from(value).toString('hex')]));
    expect(JSON.parse(new TextDecoder().decode(bytes(result, 'operator-provenance.json')))).toMatchObject({
      compilerCommit: 'b'.repeat(40), manifestDigest: sha(bytes(result, 'operator-manifest.json')),
      bundleDigest: sha(bytes(result, 'operator-bundle.json')),
    });
    await expect(compileOperatorPackage({ manifest: manifest('dispatcher'), bundle: dispatcher(), provenance: {
      repositoryId: 7, sourceCommit: 'a'.repeat(40), workflow: { id: 8, ref: 'refs/heads/main', runId: 9, runAttempt: 1 },
    } })).rejects.toThrow(/Invalid operator package/);
  });

  it.each([
    { runtime: '2.1.0', vitePlugin: '2.2.2', agents: '0.20.1' },
    { runtime: '2.2.2', vitePlugin: '2.1.0', agents: '0.20.1' },
    { runtime: '2.2.2', vitePlugin: '2.2.2', agents: '0.24.0' },
    { runtime: '2.2.3', vitePlugin: '2.2.3', agents: '0.20.1' },
    { runtime: '2.2.2', vitePlugin: '2.2.2', agents: '0.20.1', unapproved: true },
  ])('rejects mixed or unapproved SDK tuple %j without emitting a package', async versions => {
    await expect(compileOperatorPackage({ manifest: manifest('dispatcher'), bundle: { ...dispatcher(), versions } }))
      .rejects.toThrow(/Invalid operator package/);
  });

  it.each([
    () => ({ manifest: manifest(), bundle: { ...standard(), mainModule: '../worker.js' } }),
    () => ({ manifest: manifest(), bundle: { ...standard(), resources: { schemaVersion: 1, files: [{ source: 'missing', destination: 'review/file' }] } } }),
    () => ({ manifest: manifest(), bundle: { ...standard(), bindings: { SECRET: 'value' } } }),
    () => ({ manifest: { ...manifest(), credentials: 'secret' }, bundle: standard() }),
    () => ({ manifest: manifest(), bundle: { ...standard(), outbound: 'https://example.test' } }),
  ])('denies unsafe paths, invalid resources, and package-supplied authority', async makeInput => {
    await expect(compileOperatorPackage(makeInput())).rejects.toThrow(/Invalid operator package/);
  });
});
