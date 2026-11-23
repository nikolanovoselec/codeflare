import { AwsClient } from 'aws4fetch';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runHermesShutdownInference } from './hermes-shutdown-inference.js';
import { createHermesMergeStorage, HERMES_MERGE_FILES, hermesSnapshotDigest, parseHermesBaseline, runHermesShutdownMerge } from './hermes-shutdown-merge.js';
import { createHermesShutdownService } from './hermes-shutdown-service.js';

/** Use the exact scoped credentials already used by rclone; strict egress
 * re-signs the same placeholder at the existing container boundary. */
export function createHermesShutdownRuntime(env: NodeJS.ProcessEnv, syncRuntimeDir: string) {
  const { SESSION_ID: sessionId, R2_BUCKET_NAME: owner, R2_ENDPOINT: endpoint,
    R2_ACCESS_KEY_ID: accessKeyId, R2_SECRET_ACCESS_KEY: secretAccessKey } = env;
  const retrySnapshot = env.CODEFLARE_HERMES_RETRY_SNAPSHOT;
  const generation = Number(retrySnapshot ? env.CODEFLARE_HERMES_RETRY_SOURCE_GENERATION ?? env.CODEFLARE_HERMES_GENERATION
    : env.CODEFLARE_HERMES_GENERATION);
  if (env.ENTERPRISE_MODE !== 'active' || env.SESSION_MODE !== 'advanced' || env.CODEFLARE_OPERATOR_SESSION
    || !sessionId || !/^[a-z0-9]{8,24}$/.test(sessionId) || !Number.isSafeInteger(generation) || generation < 1
    || !owner || !endpoint || !accessKeyId || !secretAccessKey) return;
  const key = env.R2_SSE_DISABLED === 'true' ? undefined : env.ENCRYPTION_KEY;
  if (key && Buffer.from(key, 'base64').byteLength !== 32) return;
  const sseHeaders: Record<string, string> = key ? {
    'x-amz-server-side-encryption-customer-algorithm': 'AES256',
    'x-amz-server-side-encryption-customer-key': key,
    'x-amz-server-side-encryption-customer-key-md5': createHash('md5').update(Buffer.from(key, 'base64')).digest('base64'),
  } : {};
  const client = new AwsClient({ accessKeyId, secretAccessKey, service: 's3', region: 'auto' });
  // sign()+fetch(), not AwsClient.fetch(): an unacknowledged PUT must not be retried automatically.
  const send = async (request: Request) => {
    const signed = await client.sign(request, { aws: { allHeaders: true } });
    request.signal.throwIfAborted();
    return fetch(signed, { signal: request.signal, redirect: 'error' });
  };
  const storage = createHermesMergeStorage({ endpoint, bucket: owner, sseHeaders, send });
  const openSavedProfile = async (directory: string, signal: AbortSignal) => {
    // The retry never restores the workspace or launches a terminal. Fetch only
    // the exact saved Pi defaults and auth, using the same owner-scoped client.
    for (const file of ['settings.json', 'auth.json']) {
      const url = new URL(`/${encodeURIComponent(owner)}/.pi/agent/${file}`, endpoint);
      const response = await send(new Request(url, { headers: sseHeaders, signal, redirect: 'error' }));
      if (response.status === 404) { await response.body?.cancel(); continue; }
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('Saved Pi settings unavailable'); }
      const chunks: Uint8Array[] = [];
      let size = 0;
      for await (const chunk of response.body as ReadableStream<Uint8Array> & AsyncIterable<Uint8Array>) {
        signal.throwIfAborted();
        size += chunk.byteLength;
        if (size > 1024 * 1024) throw new Error('Saved Pi settings exceed their read budget');
        chunks.push(chunk);
      }
      await writeFile(join(directory, file), Buffer.concat(chunks), { mode: 0o600, signal, flag: 'wx' });
    }
  };
  const agentDir = env.PI_CODING_AGENT_DIR ?? '/home/user/.pi/agent';
  const store = join(env.HOME ?? '/home/user', 'Vault/Memory/Sessions', sessionId);
  return createHermesShutdownService({ owner, sessionId, generation,
    ...(retrySnapshot ? { retry: { snapshotId: retrySnapshot } } : {}),
    async identifySavedSnapshot(signal) {
      if (await readFile(join(syncRuntimeDir, 'hermes-ready'), { encoding: 'utf8', signal }) !== `direct:${sessionId}\n`) return null;
      const read = async (file: string) => {
        const handle = await open(join(store, file), constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
        try {
          const stat = await handle.stat();
          if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('Invalid saved memory file');
          return await handle.readFile({ signal });
        } finally { await handle.close(); }
      };
      const baseline = parseHermesBaseline(await read('baseline.json'));
      const active = {} as Record<typeof HERMES_MERGE_FILES[number], Uint8Array>;
      for (const file of HERMES_MERGE_FILES) active[file] = await read(file);
      return hermesSnapshotDigest(baseline, active);
    },
    async run({ source, deadline, signal, allowPersonalPiProviders, gateway }) {
      const profile = retrySnapshot ? await mkdtemp(join(tmpdir(), 'hermes-retry-')) : agentDir;
      try {
        if (retrySnapshot && allowPersonalPiProviders) await openSavedProfile(profile, signal);
        return await runHermesShutdownMerge({
          source, deadline, signal, storage, attemptId: source.intent,
          async infer(request) {
            const output = {} as Record<typeof HERMES_MERGE_FILES[number], Uint8Array>;
            for (const file of HERMES_MERGE_FILES) {
              const master = request.masters[file], changes = request.changes[file];
              const text = !changes.length && master.length <= 150_000 ? master
                : await runHermesShutdownInference({ agentDir: profile, allowPersonalPiProviders, gateway, signal: request.signal,
                  input: `Consolidate one Hermes file. Return only Markdown, with entries separated by a line containing §. Keep at most ${request.repair ? '100,000' : '150,000'} UTF-16 code units. Preserve distinct actionable facts and apply explicit corrections. Do not remove a fact just because it is absent from the additions.\n${JSON.stringify({ file, master, changes })}`,
                });
              output[file] = Buffer.from(text);
            }
            return output;
          },
        });
      } catch { return { status: 'pending' }; }
      finally { if (retrySnapshot) await rm(profile, { recursive: true, force: true }).catch(() => {}); }
    },
  });
}
