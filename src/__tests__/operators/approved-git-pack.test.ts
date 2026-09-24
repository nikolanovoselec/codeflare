import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { fetchApprovedGitPack } from '../../operators/approved-git-pack';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function git(repo: string, args: string[], input?: Uint8Array): Buffer {
  const result = spawnSync('git', ['-C', repo, ...args], {
    input: input && Buffer.from(input), env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`Fixture Git failed: ${result.stderr.toString()}`);
  return result.stdout;
}
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'approved-git-pack-')); roots.push(root);
  const repo = path.join(root, 'source'); mkdirSync(repo);
  git(repo, ['init', '-q']);
  git(repo, ['config', 'uploadpack.allowReachableSHA1InWant', 'true']);
  git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'base']);
  const base = git(repo, ['rev-parse', 'HEAD']).toString().trim();
  writeFileSync(path.join(repo, 'evidence.txt'), 'reviewed revision\n');
  git(repo, ['add', 'evidence.txt']);
  git(repo, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'head']);
  const head = git(repo, ['rev-parse', 'HEAD']).toString().trim();
  const unrelated = path.join(root, 'unrelated'); mkdirSync(unrelated);
  git(unrelated, ['init', '-q']);
  git(unrelated, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '--allow-empty', '-qm', 'unrelated']);
  const other = git(unrelated, ['rev-parse', 'HEAD']).toString().trim();
  return { root, repo, base, head, other };
}
const encode = (value: string) => Buffer.from(value);
function pkt(value: string): Buffer {
  const bytes = encode(value);
  return Buffer.concat([encode((bytes.length + 4).toString(16).padStart(4, '0')), bytes]);
}
const flush = encode('0000');
function transport(repo: string, transform?: (request: Request, response: Response) => Response | Promise<Response>) {
  return async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    expect(url.origin).toBe('https://github.com');
    expect(['/fixture/review.git/info/refs', '/fixture/review.git/git-upload-pack']).toContain(url.pathname);
    const advertisement = request.method === 'GET' && url.searchParams.get('service') === 'git-upload-pack';
    const upload = request.method === 'POST' && url.pathname.endsWith('/git-upload-pack');
    if (!advertisement && !upload) throw new Error('Unexpected Git transport request');
    expect(request.headers.get('authorization')).toBeNull();
    const output = git(repo, ['upload-pack', '--stateless-rpc', ...(advertisement ? ['--advertise-refs'] : []), repo],
      upload ? new Uint8Array(await request.arrayBuffer()) : undefined);
    const body = advertisement ? Buffer.concat([pkt('# service=git-upload-pack\n'), flush, output]) : output;
    const response = new Response(new Uint8Array(body), { headers: {
      'content-type': advertisement ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-upload-pack-result',
    } });
    return transform ? transform(request, response) : response;
  };
}
function options(f: ReturnType<typeof fixture>, overrides: Record<string, unknown> = {}) {
  return { owner: 'fixture', repository: 'review', head: f.head, acknowledgedHead: f.base,
    deadline: Date.now() + 15_000, maxPackBytes: 2 * 1024 * 1024, send: transport(f.repo), ...overrides };
}
function importPack(pack: Uint8Array, f: ReturnType<typeof fixture>, acknowledgedHead: string | null) {
  const target = path.join(f.root, `import-${Math.random().toString(36).slice(2)}`); mkdirSync(target);
  git(target, ['init', '-q']);
  git(target, ['index-pack', '--strict', '--stdin'], pack);
  expect(git(target, ['cat-file', '-t', f.head]).toString().trim()).toBe('commit');
  expect(git(target, ['show', `${f.head}:evidence.txt`]).toString()).toBe('reviewed revision\n');
  if (acknowledgedHead) {
    expect(git(target, ['cat-file', '-t', acknowledgedHead]).toString().trim()).toBe('commit');
    expect(git(target, ['merge-base', acknowledgedHead, f.head]).toString().trim()).toBe(acknowledgedHead);
  }
}

it('REQ-OPERATOR-050/053: fetches genuine v1 upload-pack bytes containing the exact head and acknowledged ancestry', async () => {
  const f = fixture();
  importPack(await fetchApprovedGitPack(options(f)), f, f.base);
});
it('REQ-OPERATOR-050/053: fetches the exact full head when no prior head was acknowledged', async () => {
  const f = fixture();
  importPack(await fetchApprovedGitPack(options(f, { acknowledgedHead: null })), f, null);
});
it('REQ-OPERATOR-053: unavailable, unadvertised and unrelated revisions deny rather than returning a partial pack', async () => {
  const f = fixture();
  for (const change of [{ head: f.other }, { acknowledgedHead: f.other }, { head: 'f'.repeat(40) }]) {
    await expect(fetchApprovedGitPack(options(f, change))).rejects.toThrow();
  }
});
it('REQ-OPERATOR-050/053: redirect and wrong smart-HTTP media type deny', async () => {
  const f = fixture();
  for (const response of [new Response(null, { status: 302, headers: { location: 'https://elsewhere.invalid/' } }),
    new Response('PACK', { headers: { 'content-type': 'text/plain' } })]) {
    await expect(fetchApprovedGitPack(options(f, { send: async () => response.clone() }))).rejects.toThrow();
  }
});
it('REQ-OPERATOR-050/053: malformed framing, truncated response and wrong sideband channel deny', async () => {
  const f = fixture();
  for (const bytes of [encode('not pkt-line'), pkt('\u0002PACKnot-data'), pkt('\u0003fatal\n'),
    Buffer.concat([pkt('NAK\n'), pkt('\u0001PACK')])]) {
    const send = transport(f.repo, async (request, response) => request.method === 'POST'
      ? new Response(new Uint8Array(bytes), { headers: response.headers }) : response);
    await expect(fetchApprovedGitPack(options(f, { send }))).rejects.toThrow();
  }
});
it('REQ-OPERATOR-050/053: pack bytes exceeding the ceiling deny without returning a truncated pack', async () => {
  const f = fixture();
  await expect(fetchApprovedGitPack(options(f, { maxPackBytes: 16 }))).rejects.toThrow();
});
it('REQ-OPERATOR-050/054: expired deadline and cancellation deny before a pack can be returned', async () => {
  const f = fixture();
  await expect(fetchApprovedGitPack(options(f, { deadline: Date.now() - 1 }))).rejects.toThrow();
  const controller = new AbortController(); controller.abort();
  await expect(fetchApprovedGitPack(options(f, { signal: controller.signal }))).rejects.toThrow();
  const pending = new AbortController();
  const send = async (_request: Request) => new Promise<Response>((_resolve, reject) => {
    pending.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true });
  });
  const running = fetchApprovedGitPack(options(f, { send, signal: pending.signal }));
  pending.abort();
  await expect(running).rejects.toThrow();
});
