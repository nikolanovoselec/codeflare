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
