import { z } from 'zod';
import type { Env } from '../types';
import { parseOperatorPolicy } from './policy';
import type { CurrentProspectiveRegistration } from './registry';
import type { RetainedRenovateRetryTarget } from './renovate-retry-proof';
import { renovateRepositoryIdentity, type RenovateRepositoryIdentity } from './renovate-run-settings';

type ParentScanTransport = {
  env: Env; exports: Record<string, (input: { props: Record<string, unknown> }) => Fetcher>;
  repository: string; human: { email: string }; bucket: string; current: () => Promise<boolean>;
};
async function readScanPage(response: Response): Promise<unknown> {
  if (!response.body) throw Error('Renovate page unavailable');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let size = 0, text = '';
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      size += chunk.value.byteLength;
      if (size > 2 * 1024 * 1024) throw Error('Renovate page exceeds byte bound');
      text += decoder.decode(chunk.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode()) as unknown;
  } catch { throw Error('Renovate page unavailable'); }
  finally { void reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function scanTransport(input: ParentScanTransport) {
  if (!input.exports.GitHubInterceptor) throw Error('GitHub transport unavailable');
  const host = input.env.GITHUB_API_HOST?.trim() || 'api.github.com';
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)) throw Error('GitHub host invalid');
  const policy = parseOperatorPolicy({ schemaVersion: 1, networkHosts: [],
    github: { repositories: [input.repository], methods: ['GET'] },
    storage: { readPrefixes: [], writePrefixes: [] },
    inference: { routeIds: [], defaultRouteId: null, reasoningLevels: [], defaultReasoningLevel: null,
      inheritUserDefaults: false } });
  const transport = input.exports.GitHubInterceptor({ props: {
    user: input.human.email, bucket: input.bucket, strict: true, operatorPolicy: policy,
  } });
  const root = `https://${host}/repos/${input.repository}`;
  return { root, get: async (path: string) => {
    if (!await input.current()) throw Error('Scan session changed');
    const response = await transport.fetch(new Request(`${root}${path}`, {
      redirect: 'manual', signal: AbortSignal.timeout(8000), headers: {
        accept: 'application/vnd.github+json', 'user-agent': 'Codeflare-Operator-Renovate',
      },
    }));
    if (response.status !== 200 || response.redirected) throw Error('Incomplete Renovate scan');
    const value = await readScanPage(response);
    if (!await input.current()) throw Error('Scan session changed');
    return { value, link: response.headers.get('link') };
  } };
}
const metadata = z.object({ id: z.number().int().positive().safe(), full_name: z.string(),
  default_branch: z.string().min(1).max(128) });
function repositoryMetadata(value: unknown, repository: string): RenovateRepositoryIdentity {
  const parsed = metadata.safeParse(value);
  if (!parsed.success || parsed.data.full_name.toLowerCase() !== repository.toLowerCase()) {
    throw Error('Renovate repository identity changed');
  }
  return { repository, repositoryId: parsed.data.id, baseBranch: parsed.data.default_branch };
}
/** Typed parent configuration supplies the path; browsers never supply a numeric identity or URL. */
export async function resolveProspectiveRenovateRepository(input: ParentScanTransport): Promise<RenovateRepositoryIdentity> {
  return repositoryMetadata((await scanTransport(input).get('')).value, input.repository);
}
const commit = z.string().regex(/^[0-9a-f]{40}$/);
const pr = z.object({ number: z.number().int().positive().safe(), state: z.literal('open'), draft: z.boolean(),
  created_at: z.string().datetime({ offset: true }), user: z.object({ id: z.number().int().safe(),
    login: z.string(), type: z.string() }), head: z.object({ sha: commit }),
  base: z.object({ ref: z.string().min(1).max(128), sha: commit,
    repo: z.object({ id: z.number().int().positive().safe(), full_name: z.string() }) }) });
export async function listProspectiveRenovatePrs(input: {
  env: Env; exports: ParentScanTransport['exports']; registration: CurrentProspectiveRegistration;
  current: () => Promise<boolean>; retainedRetryTargets?: readonly RetainedRenovateRetryTarget[];
}): Promise<Array<RenovateRepositoryIdentity & { pullRequest: number; head: string; createdAt: string }>> {
  const { registration } = input;
  const identity = renovateRepositoryIdentity.safeParse({ repository: registration.repository,
    repositoryId: registration.repositoryId, baseBranch: registration.baseBranch });
  if (!identity.success) throw Error('Renovate registration unavailable');
  const { root, get } = scanTransport({ ...input, ...registration });
  const observed = repositoryMetadata((await get('')).value, identity.data.repository);
  if (observed.repositoryId !== identity.data.repositoryId || observed.baseBranch !== identity.data.baseBranch) {
    throw Error('Renovate repository identity changed');
  }
  const found: Array<RenovateRepositoryIdentity & { pullRequest: number; head: string; createdAt: string }> = [];
  let complete = false;
  for (let page = 1; page <= 10; page++) {
    const result = await get(`/pulls?state=open&per_page=100&page=${page}`);
    const parsed = z.array(pr).max(100).safeParse(result.value);
    if (!parsed.success) throw Error('Incomplete Renovate scan');
    const rows = parsed.data;
    if (result.link) {
      if (result.link.length > 8192) throw Error('Incomplete Renovate scan');
      const links = result.link.split(',').map(value => value.trim().match(/^<([^>]+)>;\s*rel="([^"]+)"$/));
      if (links.some(value => !value)) throw Error('Incomplete Renovate scan');
      const nextLinks = links.filter(value => value![2].split(/\s+/).includes('next'));
      if (nextLinks.length > 1 || nextLinks.length && rows.length < 100) throw Error('Incomplete Renovate scan');
      if (nextLinks[0]) {
        const next = new URL(nextLinks[0][1]);
        const expected = new URL(`${root}/pulls?state=open&per_page=100&page=${page + 1}`);
        if (next.origin !== expected.origin || next.pathname !== expected.pathname || next.username || next.password || next.hash
          || [...next.searchParams].length !== 3
          || ['state', 'per_page', 'page'].some(key => next.searchParams.get(key) !== expected.searchParams.get(key))) {
          throw Error('Incomplete Renovate scan');
        }
      }
    }
    for (const row of rows) {
      if (row.draft || row.base.ref !== identity.data.baseBranch || row.base.repo.id !== identity.data.repositoryId
        || row.base.repo.full_name.toLowerCase() !== identity.data.repository.toLowerCase()
        || row.user.id !== 29139614 || row.user.login !== 'renovate[bot]' || row.user.type !== 'Bot') continue;
      const createdAt = new Date(row.created_at).toISOString();
      const retained = input.retainedRetryTargets?.some(target => target.repositoryId === identity.data.repositoryId
        && target.pullRequest === row.number && target.head === row.head.sha && target.createdAt === createdAt);
      if (createdAt > registration.activatedAt || retained) found.push({ ...identity.data,
        pullRequest: row.number, head: row.head.sha, createdAt });
    }
    if (rows.length < 100) { complete = true; break; }
  }
  if (!complete) throw Error('Renovate scan exceeds page bound');
  if (!await input.current()) throw Error('Scan session changed');
  return found;
}
