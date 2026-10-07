import { describe, expect, it } from 'vitest';
import { listProspectiveRenovatePrs } from '../../operators/renovate-prospective';
import type { CurrentProspectiveRegistration } from '../../operators/registry';
import type { Env } from '../../types';

const root = 'https://api.github.com/repos/acme/updates';
const row = (number: number) => ({ number, state: 'open', created_at: '2026-09-28T00:00:00Z',
  user: { id: 29139614, login: 'renovate[bot]', type: 'Bot' },
  draft: false, head: { sha: 'a'.repeat(40) }, base: { ref: 'trunk', sha: 'b'.repeat(40), repo: { id: 424242, full_name: 'acme/updates' } } });
const next = `${root}/pulls?state=open&per_page=100&page=2`;
function scan(pages: Array<{ rows: unknown[]; link?: string }>, metadata: unknown = { id: 424242, full_name: 'acme/updates', default_branch: 'trunk' }, current: () => Promise<boolean> = async () => true,
  onResponse: (request: Request) => void = () => {}) {
  return listProspectiveRenovatePrs({ env: {} as Env,
    registration: { bucket: 'owner', human: { email: 'owner@example.test' },
      activatedAt: '2026-09-27T00:00:00.000Z', repository: 'acme/updates', repositoryId: 424242, baseBranch: 'trunk',
      repetitionIntervalSeconds: 900 } as unknown as CurrentProspectiveRegistration,
    current,
    exports: { GitHubInterceptor: () => ({ fetch: async (request: Request) => {
      const url = new URL(request.url);
      if (url.href === root) {
        const response = metadata instanceof Response ? metadata : Response.json(metadata);
        onResponse(request);
        return response;
      }
      const page = pages[Number(url.searchParams.get('page')) - 1];
      if (!page) throw Error('Unprovided external GitHub page');
      const response = Response.json(page.rows, { headers: page.link ? { link: page.link } : {} });
      onResponse(request);
      return response;
    }, connect: () => { throw Error('Prospective GitHub reads do not open sockets'); } }) },
  });
}

describe('REQ-OPERATOR-061 AC2: prospective GitHub page completeness', () => {
  it('returns candidates from a complete terminal short page', async () => {
    expect(await scan([{ rows: [row(1)] }])).toMatchObject([{ repository: 'acme/updates', repositoryId: 424242, baseBranch: 'trunk',
      pullRequest: 1, head: 'a'.repeat(40), createdAt: '2026-09-28T00:00:00.000Z' }]);
  });
  it('reads all candidates through a valid fixed-origin continuation', async () => {
    const found = await scan([{ rows: Array.from({ length: 100 }, (_, index) => row(index + 1)),
      link: `<${next}>; rel="next"` }, { rows: [row(101)] }]);
    expect(found.map(item => item.pullRequest)).toEqual(Array.from({ length: 101 }, (_, index) => index + 1));
  });
  it('rejects a short page advertising more data instead of returning an incomplete candidate set', async () => {
    await expect(scan([{ rows: [row(1)], link: `<${next}>; rel="next"` }])).rejects.toThrow();
  });
  it.each([
    `<https://attacker.example/collect>; rel="next"`,
    `<${root}/pulls?state=open&per_page=100&page=1>; rel="next"`,
    `<${next}&page=3>; rel="next"`,
    `<${next}>; rel="next", <${next}>; rel="next"`,
    'malformed continuation',
  ])('rejects inconsistent continuation %s without admitting candidates', async link => {
    await expect(scan([{ rows: Array.from({ length: 100 }, (_, index) => row(index + 1)), link },
      { rows: [row(101)] }])).rejects.toThrow();
  });
});


describe('REQ-OPERATOR-061: configured Renovate run settings', () => {
  it.each([{ id: 1, full_name: 'acme/updates', default_branch: 'trunk' },
    { id: 424242, full_name: 'acme/renamed', default_branch: 'trunk' },
    { id: 424242, full_name: 'acme/updates', default_branch: 'main' },
    { id: '424242', full_name: 'acme/updates', default_branch: 'trunk' },
    new Response(null, { status: 302, headers: { location: 'https://attacker.example' } })])
    ('rejects changed or redirected registered metadata %j without returning partial observations', async metadata => {
      await expect(scan([{ rows: [row(1)] }], metadata)).rejects.toThrow();
    });
  it('observes only the exact bot, registered base repository and default branch after cutoff including offline arrivals', async () => {
    const valid = row(1);
    const rows = [valid, { ...row(2), created_at: '2026-09-27T00:00:00Z' },
      { ...row(3), created_at: '2026-09-26T00:00:00Z' }, { ...row(4), draft: true },
      { ...row(5), user: { ...valid.user, id: 1 } },
      { ...row(6), base: { ...valid.base, ref: 'main' } },
      { ...row(7), base: { ...valid.base, repo: { id: 1, full_name: 'acme/updates' } } },
      { ...row(8), base: { ...valid.base, repo: { id: 424242, full_name: 'other/repo' } } }];
    expect((await scan([{ rows }])).map(value => value.pullRequest)).toEqual([1]);
  });
  it('denies an entire observation when current authority changes after protected I/O', async () => {
    let authorized = true;
    await expect(scan([{ rows: [row(1)] }], undefined, async () => authorized, request => {
      if (new URL(request.url).pathname.endsWith('/pulls')) authorized = false;
    })).rejects.toThrow();
  });
  it('preserves the ten-page bound rather than accepting an incomplete large scan', async () => {
    await expect(scan(Array.from({ length: 10 }, () => ({ rows: Array.from({ length: 100 }, (_, i) => row(i + 1)) }))))
      .rejects.toThrow();
  });
});
