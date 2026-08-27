import { describe, expect, it } from 'vitest';
import {
  classifyManagedR2Request,
  type VerifiedManagedR2Policy,
} from '../../lib/managed-r2-policy';

const policy: VerifiedManagedR2Policy = {
  schemaVersion: 1,
  releaseDigest: 'd'.repeat(64),
  pathsDigest: 'e'.repeat(64),
  resourcePolicy: 'exclusive',
  paths: ['.claude/skills/company/SKILL.md', '.codeflare/managed-paths.json'],
  resourceRoots: ['.claude/skills/'],
};
const accountId = 'account';
const boundBucket = 'user-bucket';

async function classify(method: string, target: string, init: RequestInit = {}) {
  return classifyManagedR2Request({
    request: new Request(target, { method, ...init }),
    accountId,
    boundBucket,
    policy,
  });
}

describe('REQ-ENTERPRISE-028 managed R2 request classifier', () => {
  it('allows reads and listing while denying cross-bucket targets', async () => {
    expect((await classify('GET', 'https://account.r2.cloudflarestorage.com/user-bucket?list-type=2')).action).toBe('allow');
    expect((await classify('HEAD', 'https://user-bucket.account.r2.cloudflarestorage.com/.claude/skills/company/SKILL.md')).action).toBe('allow');
    expect((await classify('GET', 'https://account.r2.cloudflarestorage.com/other-bucket/key')).action).toBe('deny');
  });

  it.each([
    ['PUT', 'https://account.r2.cloudflarestorage.com/user-bucket/.claude/skills/company/SKILL.md'],
    ['DELETE', 'https://user-bucket.account.r2.cloudflarestorage.com/.claude/skills'],
    ['PUT', 'https://account.r2.cloudflarestorage.com/user-bucket/.claude/skills/personal/SKILL.md?tagging'],
    ['POST', 'https://account.r2.cloudflarestorage.com/user-bucket/.claude/skills/personal/SKILL.md?uploads'],
    ['POST', 'https://account.r2.cloudflarestorage.com/user-bucket/.claude/skills/personal/SKILL.md?uploadId=upload'],
  ])('denies protected mutation %s %s', async (method, target) => {
    expect(await classify(method, target)).toMatchObject({ action: 'deny', status: 403, code: 'AccessDenied' });
  });

  it('allows adjacent mutation and protected-source copy when the destination is adjacent', async () => {
    expect((await classify('PUT', 'https://account.r2.cloudflarestorage.com/user-bucket/.claude/skills-other/personal.md')).action).toBe('allow');
    expect((await classify('PUT', 'https://account.r2.cloudflarestorage.com/user-bucket/Vault/copy.md', {
      headers: { 'x-amz-copy-source': '/user-bucket/.claude/skills/company/SKILL.md' },
    })).action).toBe('allow');
  });

  it('decodes exactly once and rejects malformed, noncanonical, backslash, duplicate-control, and empty mutations', async () => {
    expect((await classify('PUT', 'https://account.r2.cloudflarestorage.com/user-bucket/.claude/skills/%E2%82%AC.md')).action).toBe('deny');
    expect((await classify('PUT', 'https://account.r2.cloudflarestorage.com/user-bucket/%252eclaude/skills/x')).action).toBe('allow');
    expect((await classify('PUT', 'https://account.r2.cloudflarestorage.com/user-bucket/%zz')).action).toBe('deny');
    expect((await classify('PUT', 'https://account.r2.cloudflarestorage.com/user-bucket/a%2fb')).action).toBe('deny');
    expect((await classify('PUT', 'https://account.r2.cloudflarestorage.com/user-bucket/a%5Cb')).action).toBe('deny');
    expect((await classify('POST', 'https://account.r2.cloudflarestorage.com/user-bucket/key?uploadId=a&uploadId=b')).action).toBe('deny');
    expect((await classify('PUT', 'https://account.r2.cloudflarestorage.com/user-bucket')).action).toBe('deny');
  });

  it('denies a whole mixed multi-delete and forwards exact ordinary bytes', async () => {
    const mixed = '<Delete><Object><Key>Vault/a.md</Key></Object><Object><Key>.claude/skills/company/SKILL.md</Key></Object></Delete>';
    expect((await classify('POST', 'https://account.r2.cloudflarestorage.com/user-bucket?delete', {
      headers: { 'content-type': 'application/xml' }, body: mixed,
    })).action).toBe('deny');

    const ordinary = '<Delete><Object><Key>Vault/a&amp;b.md</Key></Object><Quiet>true</Quiet></Delete>';
    const allowed = await classify('POST', 'https://account.r2.cloudflarestorage.com/user-bucket?delete', {
      headers: { 'content-type': 'application/xml' }, body: ordinary,
    });
    expect(allowed.action).toBe('allow');
    if (allowed.action === 'allow') expect(await allowed.request.text()).toBe(ordinary);
  });

  it('fails closed above the multi-delete byte and key-count bounds', async () => {
    const tooMany = `<Delete>${Array.from({ length: 1_001 }, (_, index) => `<Object><Key>Vault/${index}</Key></Object>`).join('')}</Delete>`;
    expect((await classify('POST', 'https://account.r2.cloudflarestorage.com/user-bucket?delete', {
      headers: { 'content-type': 'application/xml' }, body: tooMany,
    })).action).toBe('deny');
    expect((await classify('POST', 'https://account.r2.cloudflarestorage.com/user-bucket?delete', {
      headers: { 'content-type': 'application/xml' }, body: `<Delete><Object><Key>${'a'.repeat(1024 * 1024)}</Key></Object></Delete>`,
    })).action).toBe('deny');
  });

  it('fails closed on malformed, compressed, or ambiguous multi-delete', async () => {
    const requests: RequestInit[] = [
      { headers: { 'content-type': 'application/xml' }, body: '<Delete><Object><Key>x</Key></Delete>' },
      { headers: { 'content-type': 'application/xml', 'content-encoding': 'gzip' }, body: '<Delete><Object><Key>x</Key></Object></Delete>' },
      { headers: { 'content-type': 'application/xml' }, body: '<!DOCTYPE x><Delete><Object><Key>x</Key></Object></Delete>' },
    ];
    for (const request of requests) {
      expect((await classify('POST', 'https://account.r2.cloudflarestorage.com/user-bucket?delete', request)).action).toBe('deny');
    }
  });
});
