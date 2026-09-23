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
const dispatcher = () => ({ schemaVersion: 1, sourceCommit: 'a'.repeat(40),
  versions: { runtime: '2.1.0', vitePlugin: '2.1.0', agents: '0.20.1' }, className: 'FlueDispatcherAgent',
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

  it('emits the existing Dispatcher bundle and provenance digests over exact emitted bytes', async () => {
    const result = await compileOperatorPackage({ manifest: manifest('dispatcher'), bundle: dispatcher(), provenance: {
      repositoryId: 7, sourceCommit: 'a'.repeat(40), compilerCommit: 'b'.repeat(40), workflow: { id: 8, ref: 'refs/heads/main', runId: 9, runAttempt: 1 },
    } });
    const parsedManifest = parseOperatorManifest(new TextDecoder().decode(bytes(result, 'operator-manifest.json')), 'https://operators.example.test/');
    await expect(parseDispatcherBundle(bytes(result, 'operator-bundle.json'), parsedManifest.artifact.sha256)).resolves.toMatchObject({ className: 'FlueDispatcherAgent' });
    expect(JSON.parse(new TextDecoder().decode(bytes(result, 'operator-provenance.json')))).toMatchObject({
      compilerCommit: 'b'.repeat(40), manifestDigest: sha(bytes(result, 'operator-manifest.json')),
      bundleDigest: sha(bytes(result, 'operator-bundle.json')),
    });
    await expect(compileOperatorPackage({ manifest: manifest('dispatcher'), bundle: dispatcher(), provenance: {
      repositoryId: 7, sourceCommit: 'a'.repeat(40), workflow: { id: 8, ref: 'refs/heads/main', runId: 9, runAttempt: 1 },
    } })).rejects.toThrow(/Invalid operator package/);
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
