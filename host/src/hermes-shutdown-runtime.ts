import { constants } from 'node:fs';
import { mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { runHermesShutdownInference } from './hermes-shutdown-inference.js';
import { createHermesMergeStorage, HERMES_MERGE_FILES, hermesSnapshotDigest, parseHermesBaseline, runHermesShutdownMerge } from './hermes-shutdown-merge.js';
import { createHermesShutdownService } from './hermes-shutdown-service.js';

/** Reuse the exact rclone configuration already created for this container. */
export function createHermesShutdownRuntime(env: NodeJS.ProcessEnv, syncRuntimeDir: string) {
  const { SESSION_ID: sessionId, R2_BUCKET_NAME: owner, RCLONE_CONFIG: configFile } = env;
  const retrySnapshot = env.CODEFLARE_HERMES_RETRY_SNAPSHOT;
  const generation = Number(retrySnapshot ? env.CODEFLARE_HERMES_RETRY_SOURCE_GENERATION ?? env.CODEFLARE_HERMES_GENERATION
    : env.CODEFLARE_HERMES_GENERATION);
  if (env.ENTERPRISE_MODE !== 'active' || env.SESSION_MODE !== 'advanced' || env.CODEFLARE_OPERATOR_SESSION
    || !sessionId || !/^[a-z0-9]{8,24}$/.test(sessionId) || !Number.isSafeInteger(generation) || generation < 1
    || !owner || !configFile || !isAbsolute(configFile)) return;
  const home = env.HOME ?? '/home/user';
  const storage = createHermesMergeStorage({ bucket: owner, configFile, home, env });
  const openSavedProfile = async (directory: string, signal: AbortSignal) => {
    // Headless retry reads the saved Pi defaults and auth without restoring the workspace.
    for (const file of ['settings.json', 'auth.json'] as const) {
      const saved = await storage.readProfile(file, signal);
      if (saved) await writeFile(join(directory, file), saved, { mode: 0o600, signal, flag: 'wx' });
    }
  };
  const agentDir = env.PI_CODING_AGENT_DIR ?? '/home/user/.pi/agent';
  const store = join(home, 'Vault/Memory/Sessions', sessionId);
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
          source, deadline, signal, storage,
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
