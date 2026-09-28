import { z } from 'zod';
import type { Env } from '../types';
import { readDispatcherBody } from './operator-runtime-capability';
import { parseOperatorPolicy } from './policy';
import type { CurrentProspectiveRegistration } from './registry';

const KOMODO = 'nikolanovoselec/komodo';
const REPOSITORY_ID = 973175879;
const commit = z.string().regex(/^[0-9a-f]{40}$/);
const pr = z.object({ number: z.number().int().positive().safe(), state: z.literal('open'),
  created_at: z.string().datetime({ offset: true }), user: z.object({ id: z.number().int().safe(),
    login: z.string(), type: z.string() }), head: z.object({ sha: commit }),
  base: z.object({ ref: z.string().min(1).max(128), sha: commit }) });

/** One fixed parent-owned GitHub read, never an agent URL, repository, token or write grant. */
export async function listProspectiveRenovatePrs(input: { env: Env;
  exports: Record<string, (input: { props: Record<string, unknown> }) => Fetcher>;
  registration: CurrentProspectiveRegistration; current: () => Promise<boolean> }): Promise<
    Array<{ repositoryId: number; pullRequest: number; head: string; createdAt: string }>> {
  const { env, registration, current } = input;
  if (!input.exports.GitHubInterceptor) throw Error('GitHub transport unavailable');
  const host = env.GITHUB_API_HOST?.trim() || 'api.github.com';
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)) throw Error('GitHub host invalid');
  const policy = parseOperatorPolicy({ schemaVersion: 1, networkHosts: [],
    github: { repositories: [KOMODO], methods: ['GET'] },
    storage: { readPrefixes: [], writePrefixes: [] },
    inference: { routeIds: [], defaultRouteId: null, reasoningLevels: [], defaultReasoningLevel: null,
      inheritUserDefaults: false } });
  const transport = input.exports.GitHubInterceptor({ props: {
    user: registration.human.email, bucket: registration.bucket, strict: true, operatorPolicy: policy,
  } });
  const root = `https://${host}/repos/${KOMODO}`;
  async function get(path: string) {
    if (!await current()) throw Error('Scan session changed');
    const response = await transport.fetch(new Request(`${root}${path}`, {
      redirect: 'manual', signal: AbortSignal.timeout(8000), headers: {
        accept: 'application/vnd.github+json', 'user-agent': 'Codeflare-Operator-Renovate',
      },
    }));
    if (response.status !== 200 || response.redirected) throw Error('Incomplete Komodo scan');
    return JSON.parse(await readDispatcherBody(response)) as unknown;
  }
  const repository = z.object({ id: z.literal(REPOSITORY_ID), full_name: z.literal(KOMODO),
    default_branch: z.literal('main') }).parse(await get(''));
  if (repository.id !== REPOSITORY_ID) throw Error('Komodo identity changed');
  const found: Array<{ repositoryId: number; pullRequest: number; head: string; createdAt: string }> = [];
  let complete = false;
  for (let page = 1; page <= 10; page++) {
    const rows = z.array(pr).max(100).parse(await get(`/pulls?state=open&per_page=100&page=${page}`));
    for (const row of rows) {
      if (row.base.ref !== 'main' || row.user.id !== 29139614 || row.user.login !== 'renovate[bot]'
        || row.user.type !== 'Bot') continue;
      const createdAt = new Date(row.created_at).toISOString();
      if (createdAt > registration.activatedAt) {
        found.push({ repositoryId: REPOSITORY_ID, pullRequest: row.number, head: row.head.sha, createdAt });
      }
    }
    if (rows.length < 100) { complete = true; break; }
  }
  if (!complete) throw Error('Komodo scan exceeds page bound');
  if (!await current()) throw Error('Scan session changed');
  return found;
}
