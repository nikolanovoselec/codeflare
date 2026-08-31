import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../../types';
import { authMiddleware, requireAdmin, type AuthVariables } from '../../middleware/auth';
import {
  CONFIGURATION_SECTIONS,
  applicableConfigurationSections,
  buildConfigurationPreview,
  executeConfigurationTask,
  parseConfigurationRevision,
  resolveAdministrationMode,
  validateConfigurationValues,
  type ConfigurationSection,
} from '../../lib/admin-configuration';
import {
  ADMIN_CONFIGURATION_KEYS,
  SETUP_KEYS,
  getAdminConfigurationLatestKey,
  getAdminConfigurationRunKey,
  listAllKvKeys,
} from '../../lib/kv-keys';

const RUN_TTL_SECONDS = 90 * 24 * 60 * 60;
const LEASE_MS = 15 * 60 * 1_000;

const requestSchema = z.object({
  section: z.enum(CONFIGURATION_SECTIONS),
  baseRevision: z.number().int().nonnegative(),
  values: z.unknown(),
}).strict();

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

type RunState = 'queued' | 'running' | 'succeeded' | 'failed' | 'interrupted';
type TaskState = 'waiting' | 'running' | 'succeeded' | 'failed' | 'skipped';

interface RunError {
  code: string;
  message: string;
  retryable: boolean;
  operatorAction?: string;
}

interface ConfigurationRunTask {
  id: string;
  state: TaskState;
  startedAt?: string;
  completedAt?: string;
  error?: RunError;
}

interface ConfigurationRun {
  version: 1;
  runId: string;
  section: ConfigurationSection;
  baseRevision: number;
  resultingRevision?: number;
  initiatedBy: string;
  state: RunState;
  tasks: ConfigurationRunTask[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: RunError;
}

interface ActiveRunPointer {
  runId: string;
  updatedAt: string;
  expiresAt: string;
}

function parseObject<T>(raw: string | null): T | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as T : null;
  } catch {
    return null;
  }
}

function createRunId(): string {
  return `${String(9_999_999_999_999 - Date.now()).padStart(13, '0')}:${crypto.randomUUID()}`;
}

function terminalSummary(run: ConfigurationRun): Record<string, unknown> {
  return {
    runId: run.runId,
    section: run.section,
    state: run.state,
    baseRevision: run.baseRevision,
    ...(run.resultingRevision !== undefined && { resultingRevision: run.resultingRevision }),
    initiatedBy: run.initiatedBy,
    createdAt: run.createdAt,
    completedAt: run.completedAt,
    ...(run.error && { error: run.error }),
  };
}

async function persistRun(kv: KVNamespace, run: ConfigurationRun): Promise<void> {
  await kv.put(getAdminConfigurationRunKey(run.runId), JSON.stringify(run), { expirationTtl: RUN_TTL_SECONDS });
}

async function persistTerminal(kv: KVNamespace, run: ConfigurationRun): Promise<void> {
  await persistRun(kv, run);
  await kv.put(getAdminConfigurationLatestKey(run.section), JSON.stringify(terminalSummary(run)), {
    expirationTtl: RUN_TTL_SECONDS,
  });
}

async function heartbeat(kv: KVNamespace, runId: string): Promise<void> {
  const now = new Date();
  const pointer: ActiveRunPointer = {
    runId,
    updatedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + LEASE_MS).toISOString(),
  };
  await kv.put(ADMIN_CONFIGURATION_KEYS.ACTIVE_RUN, JSON.stringify(pointer), { expirationTtl: 15 * 60 });
}

async function recoverInterruptedRun(kv: KVNamespace, pointer: ActiveRunPointer): Promise<void> {
  const prior = parseObject<ConfigurationRun>(await kv.get(getAdminConfigurationRunKey(pointer.runId)));
  if (!prior || prior.state === 'succeeded' || prior.state === 'failed' || prior.state === 'interrupted') return;
  const completedAt = new Date().toISOString();
  const error: RunError = {
    code: 'configuration_run_interrupted',
    message: 'Settings change stopped before completion',
    retryable: true,
    operatorAction: 'Review current settings, then start a new change.',
  };
  const recovered: ConfigurationRun = {
    ...prior,
    state: 'interrupted',
    updatedAt: completedAt,
    completedAt,
    error,
    tasks: prior.tasks.map((task) => task.state === 'succeeded'
      ? task
      : {
          ...task,
          state: task.state === 'running' ? 'failed' : 'skipped',
          completedAt,
          ...(task.state === 'running' && { error }),
        }),
  };
  await persistTerminal(kv, recovered);
}

async function releaseAdmission(kv: KVNamespace, runId: string): Promise<void> {
  const pointer = parseObject<ActiveRunPointer>(await kv.get(ADMIN_CONFIGURATION_KEYS.ACTIVE_RUN));
  if (pointer?.runId === runId) await kv.delete(ADMIN_CONFIGURATION_KEYS.ACTIVE_RUN);
}

const app = new Hono<{ Bindings: Env; Variables: AuthVariables }>();
app.use('*', authMiddleware);

app.get('/', requireAdmin, async (c) => {
  const query = querySchema.safeParse(c.req.query());
  if (!query.success) return c.json({ error: 'Invalid Activity cursor or limit', code: 'validation_error' }, 400);
  const listed = await listAllKvKeys(c.env.KV, ADMIN_CONFIGURATION_KEYS.RUN_PREFIX);
  const runIds = listed
    .map((key) => key.name.slice(ADMIN_CONFIGURATION_KEYS.RUN_PREFIX.length))
    .filter((runId) => !query.data.cursor || runId > query.data.cursor)
    .sort();
  const selected = runIds.slice(0, query.data.limit);
  const items = (await Promise.all(selected.map(async (runId) =>
    parseObject<ConfigurationRun>(await c.env.KV.get(getAdminConfigurationRunKey(runId))))))
    .filter((run): run is ConfigurationRun => run !== null);
  return c.json({
    items,
    nextCursor: runIds.length > selected.length ? selected.at(-1) ?? null : null,
  });
});

app.get('/:runId', requireAdmin, async (c) => {
  const runId = c.req.param('runId');
  if (!runId) return c.json({ error: 'Configuration run not found', code: 'not_found' }, 404);
  const run = parseObject<ConfigurationRun>(await c.env.KV.get(getAdminConfigurationRunKey(runId)));
  if (!run) return c.json({ error: 'Configuration run not found', code: 'not_found' }, 404);
  return c.json(run);
});

app.post('/', requireAdmin, async (c) => {
  let payload: unknown;
  try { payload = await c.req.json(); } catch {
    return c.json({ error: 'Request body must be valid JSON', code: 'validation_error' }, 400);
  }
  const parsedRequest = requestSchema.safeParse(payload);
  if (!parsedRequest.success) {
    return c.json({ error: 'Invalid configuration run request', code: 'validation_error', fields: parsedRequest.error.flatten().fieldErrors }, 400);
  }

  const { section, baseRevision, values: rawValues } = parsedRequest.data;
  const mode = resolveAdministrationMode(c.env);
  if (!applicableConfigurationSections(mode).includes(section)) {
    return c.json({ error: 'Environment area does not apply to this deployment mode', code: 'configuration_section_not_applicable', section, mode }, 400);
  }
  const currentRevision = parseConfigurationRevision(await c.env.KV.get(ADMIN_CONFIGURATION_KEYS.REVISION));
  if (baseRevision !== currentRevision) {
    return c.json({ error: 'Environment settings changed', code: 'configuration_revision_conflict', currentRevision }, 409);
  }
  const validation = await validateConfigurationValues(c.env, section, mode, rawValues, c.get('user')?.email);
  if (!validation.values) {
    return c.json({ error: 'Environment values are invalid', code: 'validation_error', fields: validation.fieldErrors ?? {} }, 400);
  }

  const setupLock = await c.env.KV.get(SETUP_KEYS.CONFIGURING);
  const setupStartedAt = setupLock ? Number(setupLock) : NaN;
  if (Number.isFinite(setupStartedAt) && Date.now() - setupStartedAt < 60_000) {
    return c.json({ error: 'Setup configuration is active', code: 'setup_configuration_active' }, 409);
  }

  const existingPointer = parseObject<ActiveRunPointer>(await c.env.KV.get(ADMIN_CONFIGURATION_KEYS.ACTIVE_RUN));
  if (existingPointer) {
    if (Date.parse(existingPointer.expiresAt) > Date.now()) {
      return c.json({ error: 'Another settings change is active', code: 'configuration_run_active', activeRunId: existingPointer.runId }, 409);
    }
    await recoverInterruptedRun(c.env.KV, existingPointer);
    await c.env.KV.delete(ADMIN_CONFIGURATION_KEYS.ACTIVE_RUN);
  }

  const values = validation.values;
  const preview = await buildConfigurationPreview(c.env, section, mode, baseRevision, currentRevision, values);
  const createdAt = new Date().toISOString();
  let run: ConfigurationRun = {
    version: 1,
    runId: createRunId(),
    section,
    baseRevision,
    initiatedBy: c.get('user')?.email ?? 'unknown',
    state: 'queued',
    tasks: preview.tasks.map((task) => ({ id: task.id, state: 'waiting' })),
    createdAt,
    updatedAt: createdAt,
  };
  await heartbeat(c.env.KV, run.runId);
  await persistRun(c.env.KV, run);

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let observerConnected = true;
  const send = async () => {
    if (!observerConnected) return;
    try {
      await writer.write(encoder.encode(`${JSON.stringify({ type: 'snapshot', run })}\n`));
    } catch {
      observerConnected = false;
    }
  };

  const execution = (async () => {
    try {
      await send();
      const beforeWorkRevision = parseConfigurationRevision(await c.env.KV.get(ADMIN_CONFIGURATION_KEYS.REVISION));
      if (beforeWorkRevision !== baseRevision) {
        const completedAt = new Date().toISOString();
        const error: RunError = {
          code: 'configuration_revision_conflict',
          message: 'Environment settings changed before work started',
          retryable: true,
          operatorAction: 'Reload Environment settings and review the change again.',
        };
        run = {
          ...run,
          state: 'failed',
          updatedAt: completedAt,
          completedAt,
          error,
          tasks: run.tasks.map((task) => ({ ...task, state: 'skipped', completedAt })),
        };
        await persistTerminal(c.env.KV, run);
        await send();
        return;
      }

      run = { ...run, state: 'running', updatedAt: new Date().toISOString() };
      await persistRun(c.env.KV, run);
      await send();

      for (let index = 0; index < run.tasks.length; index += 1) {
        await heartbeat(c.env.KV, run.runId);
        const startedAt = new Date().toISOString();
        run = {
          ...run,
          updatedAt: startedAt,
          tasks: run.tasks.map((task, taskIndex) => taskIndex === index
            ? { ...task, state: 'running', startedAt }
            : task),
        };
        await persistRun(c.env.KV, run);
        await send();

        try {
          await executeConfigurationTask(c.env, run.tasks[index].id, values, {
            mode,
            requestUrl: c.req.url,
            resultingRevision: baseRevision + 1,
          });
        } catch {
          const completedAt = new Date().toISOString();
          const error: RunError = {
            code: 'configuration_task_failed',
            message: `Task ${run.tasks[index].id} failed`,
            retryable: true,
            operatorAction: 'Check provider availability and retry this Environment area.',
          };
          run = {
            ...run,
            state: 'failed',
            updatedAt: completedAt,
            completedAt,
            error,
            tasks: run.tasks.map((task, taskIndex) => taskIndex === index
              ? { ...task, state: 'failed', completedAt, error }
              : taskIndex > index
                ? { ...task, state: 'skipped', completedAt }
                : task),
          };
          await persistTerminal(c.env.KV, run);
          await send();
          return;
        }

        const completedAt = new Date().toISOString();
        run = {
          ...run,
          updatedAt: completedAt,
          tasks: run.tasks.map((task, taskIndex) => taskIndex === index
            ? { ...task, state: 'succeeded', completedAt }
            : task),
        };
        await heartbeat(c.env.KV, run.runId);
        await persistRun(c.env.KV, run);
        await send();
      }

      const resultingRevision = baseRevision + 1;
      await c.env.KV.put(ADMIN_CONFIGURATION_KEYS.REVISION, String(resultingRevision));
      const completedAt = new Date().toISOString();
      run = {
        ...run,
        state: 'succeeded',
        resultingRevision,
        updatedAt: completedAt,
        completedAt,
      };
      await persistTerminal(c.env.KV, run);
      await send();
    } finally {
      await releaseAdmission(c.env.KV, run.runId).catch(() => {});
      if (observerConnected) await writer.close().catch(() => {});
    }
  })();
  try {
    c.executionCtx.waitUntil(execution);
  } catch {
    // Unit tests without an ExecutionContext still consume the response stream.
  }

  return new Response(readable, { headers: { 'Content-Type': 'application/x-ndjson' } });
});

export default app;
