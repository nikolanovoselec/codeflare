import { describe, expect, it, vi } from 'vitest';
import { prepareUsageD1 } from '../../../scripts/ci/prepare-usage-d1.mjs';
import { setHeadSampling } from '../../../scripts/ci/set-head-sampling.mjs';

type WranglerCommand = string[];

const config = `
name = "codeflare"
[[d1_databases]]
binding = "USAGE_DB"
database_name = "placeholder"
database_id = "placeholder"
migrations_dir = "migrations/usage"
`;

function fakeRunner(responses: Record<string, { status: number; stdout?: string; stderr?: string }>) {
  const calls: WranglerCommand[] = [];
  const environments: Array<Record<string, string>> = [];
  const run = vi.fn(async (command: WranglerCommand, environment: Record<string, string>) => {
    calls.push(command);
    environments.push(environment);
    return responses[command.join(' ')] ?? { status: 0, stdout: '' };
  });
  return { calls, environments, run };
}

describe('observability deployment boundary (REQ-OPS-057)', () => {
  it('keeps full Integration heads and samples Production and Enterprise heads', () => {
    const source = '[observability.logs]\nhead_sampling_rate = 1\n';
    expect(setHeadSampling(source, 'integration')).toContain('head_sampling_rate = 1');
    expect(setHeadSampling(source, 'enterprise integration')).toContain('head_sampling_rate = 1');
    expect(setHeadSampling(source, 'production')).toContain('head_sampling_rate = 0.05');
    expect(setHeadSampling(source, 'enterprise')).toContain('head_sampling_rate = 0.05');
  });

  it('fails closed when the sampling contract is missing or environment is unknown', () => {
    expect(() => setHeadSampling('[observability]\nenabled = true\n', 'integration')).toThrow('head_sampling_rate');
    expect(() => setHeadSampling('[observability.logs]\nhead_sampling_rate = 1\n', 'preview')).toThrow('Unknown deployment environment');
  });
});

describe('D1 deployment boundary (REQ-OPS-056)', () => {
  it('uses the established API token for Wrangler D1 work (AC7)', async () => {
    const fake = fakeRunner({
      'd1 list --json': { status: 0, stdout: JSON.stringify([{ uuid: '22222222-2222-4222-8222-222222222222', name: 'codeflare-integration-usage' }]) },
      'd1 migrations apply codeflare-integration-usage --remote': { status: 0 },
    });
    await prepareUsageD1({
      workerName: 'codeflare-integration', apiToken: 'api-token', wranglerConfig: config, run: fake.run,
    });
    expect(fake.environments).not.toHaveLength(0);
    expect(fake.environments.every((environment) => environment.CLOUDFLARE_API_TOKEN === 'api-token')).toBe(true);
  });

  it('rejects a missing established API token before any Wrangler call', async () => {
    const fake = fakeRunner({});
    await expect(prepareUsageD1({
      workerName: 'codeflare-integration',
      apiToken: '',
      wranglerConfig: config,
      run: fake.run,
    })).rejects.toThrow('CLOUDFLARE_API_TOKEN');
    expect(fake.run).not.toHaveBeenCalled();
  });

  it('fails closed when D1 listing permission is unavailable', async () => {
    const fake = fakeRunner({
      'd1 list --json': { status: 1, stderr: 'permission denied' },
    });
    await expect(prepareUsageD1({
      workerName: 'codeflare-integration', apiToken: 'api-token', wranglerConfig: config, run: fake.run,
    })).rejects.toThrow('Could not list D1 databases');
    expect(fake.calls).toEqual([['d1', 'list', '--json']]);
  });

  it('creates one absent database with supported Wrangler arguments, resolves its ID, then applies migrations', async () => {
    const database = { uuid: '11111111-1111-4111-8111-111111111111', name: 'codeflare-integration-usage' };
    const calls: WranglerCommand[] = [];
    let listCalls = 0;
    const run = vi.fn(async (command: WranglerCommand) => {
      calls.push(command);
      const key = command.join(' ');
      if (key === 'd1 list --json') {
        listCalls += 1;
        return { status: 0, stdout: JSON.stringify(listCalls === 1 ? [] : [database]) };
      }
      if (key === 'd1 create codeflare-integration-usage') return { status: 0, stdout: 'Database created' };
      if (key === 'types' || key === 'd1 migrations apply codeflare-integration-usage --remote') return { status: 0, stdout: '' };
      return { status: 1, stderr: `Unsupported command: ${key}` };
    });
    const result = await prepareUsageD1({
      workerName: 'codeflare-integration', apiToken: 'api-token', wranglerConfig: config, run,
    });
    expect(result.databaseId).toBe(database.uuid);
    expect(result.created).toBe(true);
    expect(result.wranglerConfig.match(/binding = "USAGE_DB"/g)).toHaveLength(1);
    expect(result.wranglerConfig).toContain('database_name = "codeflare-integration-usage"');
    expect(result.wranglerConfig).toContain(`database_id = "${database.uuid}"`);
    expect(calls).toEqual([
      ['d1', 'list', '--json'],
      ['d1', 'create', 'codeflare-integration-usage'],
      ['d1', 'list', '--json'],
      ['types'],
      ['d1', 'migrations', 'apply', 'codeflare-integration-usage', '--remote'],
    ]);
  });

  it('reuses one exact database and rejects duplicate exact names', async () => {
    const existing = { uuid: '22222222-2222-4222-8222-222222222222', name: 'codeflare-integration-usage' };
    const reuse = fakeRunner({
      'd1 list --json': { status: 0, stdout: JSON.stringify([existing]) },
      'd1 migrations apply codeflare-integration-usage --remote': { status: 0 },
    });
    const result = await prepareUsageD1({
      workerName: 'codeflare-integration', apiToken: 'api-token', wranglerConfig: config, run: reuse.run,
    });
    expect(result.created).toBe(false);
    expect(reuse.calls.some((call) => call[1] === 'create')).toBe(false);

    const duplicate = fakeRunner({
      'd1 list --json': { status: 0, stdout: JSON.stringify([existing, { ...existing, uuid: '33333333-3333-4333-8333-333333333333' }]) },
    });
    await expect(prepareUsageD1({
      workerName: 'codeflare-integration', apiToken: 'api-token', wranglerConfig: config, run: duplicate.run,
    })).rejects.toThrow('duplicate');
    expect(duplicate.calls).toHaveLength(1);
  });

  it.each(['codeflare', 'codeflare-integration', 'codeflare-enterprise', 'codeflare-enterprise-integration'])(
    'REQ-OPS-056 AC1/6: resolves only %s usage binding and emits no resource-reset commands', async (workerName) => {
      const database = { uuid: '55555555-5555-4555-8555-555555555555', name: `${workerName}-usage` };
      const input = `${config}
[[kv_namespaces]]
binding = "KV"
id = "existing-kv"
[[r2_buckets]]
binding = "R2"
bucket_name = "existing-bucket"
[durable_objects]
bindings = [{ name = "TIMEKEEPER", class_name = "Timekeeper" }]
[[migrations]]
tag = "existing-do-migration"
new_sqlite_classes = ["Timekeeper"]
[[containers]]
class_name = "container"
image = "registry.example/existing@sha256:fixture"
max_instances = 3
`;
      const fake = fakeRunner({
        'd1 list --json': { status: 0, stdout: JSON.stringify([
          { uuid: '88888888-8888-4888-8888-888888888888', name: `${workerName}-usage-archive` },
          database,
          { uuid: '99999999-9999-4999-8999-999999999999', name: `${workerName}-other-usage` },
        ]) },
      });
      const written: string[] = [];
      const result = await prepareUsageD1({
        workerName, apiToken: 'api-token', wranglerConfig: input, run: fake.run,
        writeConfig: async (content = '') => { written.push(content); },
      });

      // Generated configuration and external command arguments are the contracts;
      // this does not observe lifetime or contents of any provider resource.
      const expected = input.replace('database_name = "placeholder"', `database_name = "${database.name}"`)
        .replace('database_id = "placeholder"', `database_id = "${database.uuid}"`);
      expect(result).toEqual({ databaseId: database.uuid, databaseName: database.name, created: false, wranglerConfig: expected });
      expect(written).toEqual([expected]);
      expect(fake.calls).toEqual([
        ['d1', 'list', '--json'],
        ['types'],
        ['d1', 'migrations', 'apply', database.name, '--remote'],
      ]);
    },
  );

  it('REQ-OPS-166 AC1/2: waits for binding type generation and refuses migration when generation fails', async () => {
    const database = { uuid: '66666666-6666-4666-8666-666666666666', name: 'codeflare-integration-usage' };
    let releaseTypes!: (result: { status: number; stderr: string }) => void;
    const types = new Promise<{ status: number; stderr: string }>((resolve) => { releaseTypes = resolve; });
    let enteredTypes!: () => void;
    const typesEntered = new Promise<void>((resolve) => { enteredTypes = resolve; });
    const calls: WranglerCommand[] = [];
    const written: string[] = [];
    const preparation = prepareUsageD1({
      workerName: 'codeflare-integration', apiToken: 'api-token', wranglerConfig: config,
      writeConfig: async (content = '') => { written.push(content); },
      run: async (command: WranglerCommand) => {
        calls.push(command);
        if (command[0] === 'd1') return { status: 0, stdout: JSON.stringify([database]) };
        enteredTypes();
        return types;
      },
    });
    const failure = expect(preparation).rejects.toThrow('Worker binding type generation failed: invalid binding');
    await typesEntered;
    expect(written).toEqual([config.replace('database_name = "placeholder"', `database_name = "${database.name}"`)
      .replace('database_id = "placeholder"', `database_id = "${database.uuid}"`)]);
    expect(calls).toEqual([['d1', 'list', '--json'], ['types']]);
    releaseTypes({ status: 1, stderr: 'invalid binding' });
    await failure;
    expect(calls).toEqual([['d1', 'list', '--json'], ['types']]);
  });

  it.each([0, 1])('REQ-OPS-056 AC5 / REQ-OPS-166 AC2: awaits migration status %i without compensating mutation', async (status) => {
    const database = { uuid: '77777777-7777-4777-8777-777777777777', name: 'codeflare-integration-usage' };
    let releaseMigration!: (result: { status: number; stderr: string }) => void;
    const migration = new Promise<{ status: number; stderr: string }>((resolve) => { releaseMigration = resolve; });
    let enteredMigration!: () => void;
    const migrationEntered = new Promise<void>((resolve) => { enteredMigration = resolve; });
    const calls: WranglerCommand[] = [];
    const written: string[] = [];
    const preparation = prepareUsageD1({
      workerName: 'codeflare-integration', apiToken: 'api-token', wranglerConfig: config,
      writeConfig: async (content = '') => { written.push(content); },
      run: async (command: WranglerCommand) => {
        calls.push(command);
        if (command[0] === 'types') return { status: 0 };
        if (command[1] === 'list') return { status: 0, stdout: JSON.stringify([database]) };
        enteredMigration();
        return migration;
      },
    });
    let outcome: unknown = 'pending';
    const settled = preparation.then(
      (result: unknown) => { outcome = result; },
      (error: unknown) => { outcome = error; },
    );
    await migrationEntered;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(outcome).toBe('pending');
    const expected = config.replace('database_name = "placeholder"', `database_name = "${database.name}"`)
      .replace('database_id = "placeholder"', `database_id = "${database.uuid}"`);
    expect(written).toEqual([expected]);
    releaseMigration({ status, stderr: status ? 'migration refused' : '' });
    await settled;
    if (status) {
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toBe('D1 migration failed: migration refused');
    } else {
      expect(outcome).toEqual({ databaseId: database.uuid, databaseName: database.name, created: false, wranglerConfig: expected });
    }
    expect(written).toEqual([expected]);
    expect(calls).toEqual([
      ['d1', 'list', '--json'], ['types'],
      ['d1', 'migrations', 'apply', database.name, '--remote'],
    ]);
  });

  it('stops on migration failure after provisioning without invoking later mutation', async () => {
    const fake = fakeRunner({
      'd1 list --json': { status: 0, stdout: JSON.stringify([{ uuid: '44444444-4444-4444-8444-444444444444', name: 'codeflare-integration-usage' }]) },
      'd1 migrations apply codeflare-integration-usage --remote': { status: 1, stderr: 'migration failed' },
    });
    await expect(prepareUsageD1({
      workerName: 'codeflare-integration', apiToken: 'api-token', wranglerConfig: config, run: fake.run,
    })).rejects.toThrow('migration failed');
    expect(fake.calls).toHaveLength(3);
  });
});
