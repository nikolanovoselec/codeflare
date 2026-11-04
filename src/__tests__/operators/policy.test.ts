/**
 * Test navigation: Strict restriction declarations, safe host/storage rules and allowed defaults; parsing is not runtime authorization.
 * Fixtures are local/CI evidence, not production deployment or live Access acceptance.
 * Requirement IDs in describe blocks link each behavior to sdd/spec/operators.md.
 */
import { describe, expect, it } from 'vitest';
import { ValidationError } from '../../lib/error-types';
import { parseOperatorPolicy, type OperatorPolicy } from '../../operators/policy';

const restricted = (): OperatorPolicy => ({ schemaVersion: 1,
  networkHosts: ['api.example.test', '*.example.org'],
  github: { repositories: [], methods: [] },
  storage: { readPrefixes: ['inputs/'], writePrefixes: ['outputs/'] },
  inference: { routeIds: ['approved-route'], defaultRouteId: 'approved-route',
    reasoningLevels: ['off', 'high'], defaultReasoningLevel: 'high', inheritUserDefaults: false },
});

describe('REQ-OPERATOR-014: bounded restrictive registration policy', () => {
  it('preserves explicit restrictions without adding authority or fallback', () => {
    expect(parseOperatorPolicy(restricted())).toEqual(restricted());
    const denied = { ...restricted(), networkHosts: [], storage: { readPrefixes: [], writePrefixes: [] },
      inference: { routeIds: [], defaultRouteId: null, reasoningLevels: [], defaultReasoningLevel: null, inheritUserDefaults: false } };
    expect(parseOperatorPolicy(denied)).toEqual(denied);
  });
  it.each(['https://example.test', 'example.test:443', '127.0.0.1', '*', '*.com', 'example.test/path'])
  ('rejects unsafe hostname rule %s', host => {
    expect(() => parseOperatorPolicy({ ...restricted(), networkHosts: [host] })).toThrow(ValidationError);
  });
  it.each(['../other/', '/other/', '', 'outputs/../other/', 'outputs/%2e%2e/', 'outputs\\other/'])
  ('rejects unsafe storage prefix %s', prefix => {
    expect(() => parseOperatorPolicy({ ...restricted(), storage: { readPrefixes: [prefix], writePrefixes: [] } })).toThrow(ValidationError);
  });
  it.each([
    { schemaVersion: 2 }, { principal: 'another-user' }, { bucket: 'another-bucket' },
    { github: { repositories: ['*'], methods: ['GET'] } },
    { github: { repositories: ['owner/repo'], methods: ['CONNECT'] } },
    { networkHosts: Array.from({ length: 129 }, (_, index) => `h${index}.example.test`) },
  ])('rejects unsupported or excessive policy data %#', patch => {
    expect(() => parseOperatorPolicy({ ...restricted(), ...patch })).toThrow(ValidationError);
  });
  it.each([
    { defaultRouteId: 'unlisted-route' }, { defaultReasoningLevel: 'low' },
    { reasoningLevels: ['unsupported'], defaultReasoningLevel: null },
    { routeIds: ['approved-route', 'approved-route'] },
  ])('rejects defaults outside explicit restrictions %#', patch => {
    expect(() => parseOperatorPolicy({ ...restricted(), inference: { ...restricted().inference, ...patch } })).toThrow(ValidationError);
  });
});


describe('REQ-OPERATOR-014: explicit native source restriction', () => {
  it('accepts an approved native source without inventing a managed route or changing other restrictions', () => {
    const declared = { ...restricted(), inference: { routeIds: [], defaultRouteId: null,
      reasoningLevels: ['low', 'high'], defaultReasoningLevel: null, inheritUserDefaults: false,
      allowedSources: ['pi-native'] } };
    expect(parseOperatorPolicy(declared)).toEqual(declared);
  });

  it('preserves separate managed and native source approval without granting credential or owner authority', () => {
    const declared = { ...restricted(), inference: { ...restricted().inference,
      allowedSources: ['managed', 'pi-native'] } };
    expect(parseOperatorPolicy(declared)).toEqual(declared);
    expect(() => parseOperatorPolicy({ ...declared, owner: 'another-user' })).toThrow(ValidationError);
    expect(() => parseOperatorPolicy({ ...declared, inference: { ...declared.inference,
      allowedSources: ['pi-native', 'arbitrary-provider'] } })).toThrow(ValidationError);
  });
});
