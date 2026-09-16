/**
 * Shared restrictive decisions independent of transport and credentials. These
 * fixtures prove exact/wildcard network, repository/method and scoped storage
 * semantics; interceptor suites separately prove decisions happen before secrets.
 */
import { describe, expect, it } from 'vitest';
import type { OperatorPolicy } from '../../operators/policy';
import { decideOperatorGithub, decideOperatorNetwork, decideOperatorStorage } from '../../operators/interception-policy';

const policy = (overrides: Partial<OperatorPolicy> = {}): OperatorPolicy => ({
  schemaVersion: 1, networkHosts: ['api.example.test', '*.services.example.test'],
  github: { repositories: ['octo/allowed'], methods: ['GET', 'POST'] },
  storage: { readPrefixes: ['inputs/'], writePrefixes: ['outputs/activity/'] },
  inference: { routeIds: ['safe-route'], defaultRouteId: 'safe-route', reasoningLevels: ['medium'],
    defaultReasoningLevel: 'medium', inheritUserDefaults: false }, ...overrides,
});

describe('REQ-OPERATOR-004: shared operator restriction decisions', () => {
  it('matches exact and subdomain wildcard hosts without granting the apex or lookalikes', () => {
    expect(decideOperatorNetwork(policy(), 'api.example.test')).toEqual({ allowed: true });
    expect(decideOperatorNetwork(policy(), 'a.services.example.test')).toEqual({ allowed: true });
    for (const host of ['services.example.test', 'badservices.example.test', 'api.example.test.evil.test',
      'API.EXAMPLE.TEST.', '127.0.0.1']) expect(decideOperatorNetwork(policy(), host).allowed).toBe(false);
  });

  it('does not let general host rules bypass specialized GitHub destinations', () => {
    const permissive = policy({ networkHosts: ['github.com', 'api.github.com', '*.githubusercontent.com'] });
    for (const host of ['github.com', 'api.github.com', 'raw.githubusercontent.com']) {
      expect(decideOperatorNetwork(permissive, host)).toEqual({ allowed: false, reason: 'specialized-destination' });
    }
  });

  it('authorizes only a declared GitHub repository and method from canonical REST and git paths', () => {
    expect(decideOperatorGithub(policy(), new Request('https://api.github.com/repos/octo/allowed/issues'))).toEqual({ allowed: true });
    expect(decideOperatorGithub(policy(), new Request('https://api.github.com/repos/OCTO/ALLOWED/pulls', { method: 'POST' }))).toEqual({ allowed: true });
    expect(decideOperatorGithub(policy(), new Request('https://github.com/octo/allowed.git/info/refs'))).toEqual({ allowed: true });
    for (const request of [new Request('https://api.github.com/user'),
      new Request('https://api.github.com/repos/octo/other/issues'),
      new Request('https://api.github.com/repos/octo/allowed', { method: 'DELETE' }),
      new Request('https://github.com/octo/allowed-extra.git/info/refs')]) {
      expect(decideOperatorGithub(policy(), request).allowed).toBe(false);
    }
  });

  it('denies malformed or unsupported GitHub hosts before any transport', () => {
    for (const url of ['https://evil.test/repos/octo/allowed', 'https://api.github.com/repos/octo/%2e%2e',
      'https://github.com/octo/allowed']) {
      expect(decideOperatorGithub(policy(), new Request(url)).allowed).toBe(false);
    }
  });

  it('allows canonical reads/writes only within their distinct owner-relative prefixes', () => {
    expect(decideOperatorStorage(policy(), 'read', 'inputs/context.json')).toEqual({ allowed: true });
    expect(decideOperatorStorage(policy(), 'list', 'inputs/')).toEqual({ allowed: true });
    expect(decideOperatorStorage(policy(), 'write', 'outputs/activity/result.json')).toEqual({ allowed: true });
    expect(decideOperatorStorage(policy(), 'multipart-write', 'outputs/activity/large.bin')).toEqual({ allowed: true });
    for (const [operation, path] of [['read', 'outputs/activity/result.json'], ['write', 'inputs/context.json'],
      ['write', 'outputs/activity-escape/result'], ['read', '../inputs/context'], ['write', 'outputs/activity//x']] as const) {
      expect(decideOperatorStorage(policy(), operation, path).allowed).toBe(false);
    }
  });

  it('denies copy/delete/control and permits abort only for the owned multipart operation', () => {
    for (const operation of ['copy', 'delete', 'control'] as const) {
      expect(decideOperatorStorage(policy(), operation, 'outputs/activity/result.json').allowed).toBe(false);
    }
    expect(decideOperatorStorage(policy(), 'multipart-abort', 'outputs/activity/large.bin', false).allowed).toBe(false);
    expect(decideOperatorStorage(policy(), 'multipart-abort', 'outputs/activity/large.bin', true)).toEqual({ allowed: true });
  });

  it('treats empty lists as deny-all without implicit defaults', () => {
    const empty = policy({ networkHosts: [], github: { repositories: [], methods: [] },
      storage: { readPrefixes: [], writePrefixes: [] } });
    expect(decideOperatorNetwork(empty, 'api.example.test').allowed).toBe(false);
    expect(decideOperatorGithub(empty, new Request('https://api.github.com/repos/octo/allowed')).allowed).toBe(false);
    expect(decideOperatorStorage(empty, 'read', 'inputs/context.json').allowed).toBe(false);
  });
});
