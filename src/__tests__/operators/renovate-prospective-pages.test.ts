import { describe, expect, it } from 'vitest';
import { listProspectiveRenovatePrs } from '../../operators/renovate-prospective';
import type { CurrentProspectiveRegistration } from '../../operators/registry';
import type { Env } from '../../types';

const root = 'https://api.github.com/repos/nikolanovoselec/komodo';
const row = (number: number) => ({ number, state: 'open', created_at: '2026-09-28T00:00:00Z',
  user: { id: 29139614, login: 'renovate[bot]', type: 'Bot' },
  head: { sha: 'a'.repeat(40) }, base: { ref: 'main', sha: 'b'.repeat(40) } });
const next = `${root}/pulls?state=open&per_page=100&page=2`;
function scan(pages: Array<{ rows: unknown[]; link?: string }>) {
  return listProspectiveRenovatePrs({ env: {} as Env,
    registration: { bucket: 'owner', human: { email: 'owner@example.test' },
      activatedAt: '2026-09-27T00:00:00.000Z' } as CurrentProspectiveRegistration,
    current: async () => true,
    exports: { GitHubInterceptor: () => ({ fetch: async (request: Request) => {
      const url = new URL(request.url);
      if (url.href === root) return Response.json({ id: 973175879,
        full_name: 'nikolanovoselec/komodo', default_branch: 'main' });
      const page = pages[Number(url.searchParams.get('page')) - 1];
      if (!page) throw Error('Unprovided external GitHub page');
      return Response.json(page.rows, { headers: page.link ? { link: page.link } : {} });
    } }) },
  });
}

describe('REQ-OPERATOR-061 AC2: prospective GitHub page completeness', () => {
  it('returns candidates from a complete terminal short page', async () => {
    expect(await scan([{ rows: [row(1)] }])).toEqual([{ repositoryId: 973175879,
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
