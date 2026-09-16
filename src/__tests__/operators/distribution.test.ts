/**
 * Test navigation: Pure manifest/bundle parsing fixtures: malformed data, canonical paths, compatibility and exact-byte integrity.
 * Fixtures are local/CI evidence, not production deployment or live Access acceptance.
 * Requirement IDs in describe blocks link each behavior to sdd/spec/operators.md.
 */
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../lib/error-types';
import { parseOperatorManifest, parseOperatorBundle } from '../../operators/distribution';

const ENDPOINT = 'https://operator.example.test/discovery';
const manifest = () => ({
  schemaVersion: 1,
  interfaceVersion: 1,
  id: 'example-operator',
  name: 'Example operator',
  description: 'Platform acceptance fixture',
  coreVersion: '1.0.0',
  intentVersion: '1.0.0',
  inputSchema: { type: 'object', properties: { message: { type: 'string' } } },
  requiredCapabilities: ['inference', 'session', 'storage'],
  artifact: { path: '/bundles/example.json', sha256: 'a'.repeat(64) },
});
const bundle = () => ({
  schemaVersion: 1,
  interfaceVersion: 1,
  compatibilityDate: '2026-02-05',
  compatibilityFlags: ['nodejs_compat'],
  mainModule: 'index.js',
  modules: {
    'index.js': { js: 'export default { fetch() { return new Response("fixture"); } };' },
    'resources/intent.txt': { text: 'Create the requested test marker.' },
  },
});
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
async function digest(bytes: Uint8Array): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)))
    .map(byte => byte.toString(16).padStart(2, '0')).join('');
}

 describe('REQ-OPERATOR-010: operator discovery boundary', () => {
  it('returns compatible metadata and resolves the artifact only within the registered origin', () => {
    const input = manifest();
    expect(parseOperatorManifest(JSON.stringify(input), ENDPOINT)).toEqual({
      ...input,
      artifact: { ...input.artifact, url: 'https://operator.example.test/bundles/example.json' },
    });
  });

  it.each([
    ['schema version', { schemaVersion: 2 }],
    ['interface version', { interfaceVersion: 2 }],
    ['missing ID', { id: undefined }],
    ['invalid ID', { id: '../other' }],
    ['empty name', { name: '' }],
    ['unknown capability', { requiredCapabilities: ['administrator'] }],
    ['duplicate capability', { requiredCapabilities: ['session', 'session'] }],
    ['caller identity', { principalId: 'other-user' }],
    ['caller bindings', { bindings: { BUCKET: 'other' } }],
    ['invalid input metadata', { inputSchema: [] }],
    ['missing core version', { coreVersion: undefined }],
  ])('rejects %s', (_label, patch) => {
    expect(() => parseOperatorManifest(JSON.stringify({ ...manifest(), ...patch }), ENDPOINT))
      .toThrow(ValidationError);
  });

  it.each([
    'http://operator.example.test/discovery',
    'https://user:password@operator.example.test/discovery',
    'https://operator.example.test/discovery#fragment',
    'https://127.0.0.1/discovery',
    'https://[::1]/discovery',
    'https://localhost/discovery',
    'not-a-url',
  ])('rejects unsafe registration endpoint %s', endpoint => {
    expect(() => parseOperatorManifest(JSON.stringify(manifest()), endpoint)).toThrow(ValidationError);
  });

  it.each([
    '//other.example.test/bundle.json', 'https://other.example.test/bundle.json',
    '/bundles/../secret', '/bundles/./bundle.json', '/bundles/%2e%2e/secret',
    '/bundles\\secret', '/bundle.json?secret=value', '/bundle.json#fragment',
  ])('rejects noncanonical artifact path %s', path => {
    expect(() => parseOperatorManifest(JSON.stringify({
      ...manifest(), artifact: { path, sha256: 'a'.repeat(64) },
    }), ENDPOINT)).toThrow(ValidationError);
  });

  it('rejects malformed JSON, invalid digest and metadata over the UTF-8 byte bound', () => {
    expect(() => parseOperatorManifest('<html>Login</html>', ENDPOINT)).toThrow(ValidationError);
    expect(() => parseOperatorManifest(JSON.stringify({
      ...manifest(), artifact: { path: '/bundle.json', sha256: 'not-a-digest' },
    }), ENDPOINT)).toThrow(ValidationError);
    expect(() => parseOperatorManifest(JSON.stringify({
      ...manifest(), description: 'é'.repeat(33 * 1024),
    }), ENDPOINT)).toThrow(ValidationError);
  });
});

describe('REQ-OPERATOR-010: approved bundle boundary', () => {
  it('returns only validated approved bundle data without evaluating JavaScript', async () => {
    const input = bundle();
    input.modules['index.js'].js = 'throw new Error("Module must not execute during validation");';
    const bytes = encode(input);
    expect(await parseOperatorBundle(bytes, await digest(bytes))).toEqual(input);
  });

  it('rejects tampered bytes despite otherwise valid bundle shape', async () => {
    const original = encode(bundle());
    const changed = encode({ ...bundle(), modules: { 'index.js': { js: 'export default {};' } } });
    await expect(parseOperatorBundle(changed, await digest(original))).rejects.toThrow(ValidationError);
  });

  it.each([
    ['schema version', { schemaVersion: 2 }],
    ['interface version', { interfaceVersion: 2 }],
    ['undeclared main', { mainModule: 'missing.js' }],
    ['compatibility date', { compatibilityDate: '2099-01-01' }],
    ['compatibility flags', { compatibilityFlags: ['unknown_flag'] }],
    ['inherited environment', { env: { SECRET: 'never-inherit' } }],
    ['outbound override', { globalOutbound: null }],
    ['text main', { modules: { 'index.js': { text: 'not executable' } } }],
    ['unsupported module', { modules: { 'index.js': { py: 'print("no")' } } }],
    ['ambiguous module type', { modules: { 'index.js': { js: 'export default {};', text: 'ambiguous' } } }],
  ])('rejects approved bytes with %s', async (_label, patch) => {
    const bytes = encode({ ...bundle(), ...patch });
    await expect(parseOperatorBundle(bytes, await digest(bytes))).rejects.toThrow(ValidationError);
  });

  it.each(['../escape.js', '/absolute.js', 'a/../escape.js', 'a\\escape.js', 'a/%2e%2e/escape.js'])
    ('rejects unsafe module name %s', async name => {
      const input = bundle();
      const bytes = encode({ ...input, modules: { ...input.modules, [name]: { js: 'export default {};' } } });
      await expect(parseOperatorBundle(bytes, await digest(bytes))).rejects.toThrow(ValidationError);
    });

  it('rejects malformed JSON and excessive module count even with matching approved digest', async () => {
    const malformed = new TextEncoder().encode('not JSON');
    await expect(parseOperatorBundle(malformed, await digest(malformed))).rejects.toThrow(ValidationError);
    const modules = Object.fromEntries(Array.from({ length: 129 }, (_, i) => [`module-${i}.js`, { js: '' }]));
    const bytes = encode({ ...bundle(), mainModule: 'module-0.js', modules });
    await expect(parseOperatorBundle(bytes, await digest(bytes))).rejects.toThrow(ValidationError);
  });

  it('rejects oversized artifacts and malformed digest without disclosing source', async () => {
    await expect(parseOperatorBundle(new Uint8Array(8 * 1024 * 1024 + 1), 'a'.repeat(64)))
      .rejects.toThrow(ValidationError);
    const bytes = encode(bundle());
    await expect(parseOperatorBundle(bytes, 'not-a-digest')).rejects.toThrow(ValidationError);
  });
});
