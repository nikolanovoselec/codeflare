import { describe, expect, it, vi } from 'vitest';
import { prepareUsageD1, type WranglerCommand } from '../../../scripts/ci/prepare-usage-d1.mjs';

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
  const run = vi.fn(async (command: WranglerCommand) => {
    calls.push(command);
    return responses[command.join(' ')] ?? { status: 0, stdout: '' };
  });
  return { calls, run };
}

describe('D1 deployment boundary (REQ-OPS-056)', () => {
  it('rejects missing separate or runtime credentials before any Wrangler call', async () => {
    const fake = fakeRunner({});
    await expect(prepareUsageD1({
      workerName: 'codeflare-integration',
      deployToken: '',
      runtimeToken: 'runtime',
      wranglerConfig: config,
      run: fake.run,
    })).rejects.toThrow('CLOUDFLARE_DEPLOY_API_TOKEN');
    await expect(prepareUsageD1({
      workerName: 'codeflare-integration',
      deployToken: 'deploy',
      runtimeToken: '',
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
      workerName: 'codeflare-integration', deployToken: 'deploy', runtimeToken: 'runtime', wranglerConfig: config, run: fake.run,
    })).rejects.toThrow('Could not list D1 databases');
    expect(fake.calls).toEqual([['d1', 'list', '--json']]);
  });

  it('creates one absent database, renders one binding, then applies migrations', async () => {
    const fake = fakeRunner({
      'd1 list --json': { status: 0, stdout: '[]' },
      'd1 create codeflare-integration-usage --json': {
        status: 0,
        stdout: JSON.stringify({ uuid: '11111111-1111-4111-8111-111111111111', name: 'codeflare-integration-usage' }),
      },
      'd1 migrations apply codeflare-integration-usage --remote': { status: 0 },
    });
    const result = await prepareUsageD1({
      workerName: 'codeflare-integration', deployToken: 'deploy', runtimeToken: 'runtime', wranglerConfig: config, run: fake.run,
    });
    expect(result.databaseId).toBe('11111111-1111-4111-8111-111111111111');
    expect(result.created).toBe(true);
    expect(result.wranglerConfig.match(/binding = "USAGE_DB"/g)).toHaveLength(1);
    expect(result.wranglerConfig).toContain('database_name = "codeflare-integration-usage"');
    expect(result.wranglerConfig).toContain('database_id = "11111111-1111-4111-8111-111111111111"');
    expect(fake.calls.at(-1)).toEqual(['d1', 'migrations', 'apply', 'codeflare-integration-usage', '--remote']);
  });

  it('reuses one exact database and rejects duplicate exact names', async () => {
    const existing = { uuid: '22222222-2222-4222-8222-222222222222', name: 'codeflare-integration-usage' };
    const reuse = fakeRunner({
      'd1 list --json': { status: 0, stdout: JSON.stringify([existing]) },
      'd1 migrations apply codeflare-integration-usage --remote': { status: 0 },
    });
    const result = await prepareUsageD1({
      workerName: 'codeflare-integration', deployToken: 'deploy', runtimeToken: 'runtime', wranglerConfig: config, run: reuse.run,
    });
    expect(result.created).toBe(false);
    expect(reuse.calls.some((call) => call[1] === 'create')).toBe(false);

    const duplicate = fakeRunner({
      'd1 list --json': { status: 0, stdout: JSON.stringify([existing, { ...existing, uuid: '33333333-3333-4333-8333-333333333333' }]) },
    });
    await expect(prepareUsageD1({
      workerName: 'codeflare-integration', deployToken: 'deploy', runtimeToken: 'runtime', wranglerConfig: config, run: duplicate.run,
    })).rejects.toThrow('duplicate');
    expect(duplicate.calls).toHaveLength(1);
  });

  it('stops on migration failure after provisioning without invoking later mutation', async () => {
    const fake = fakeRunner({
      'd1 list --json': { status: 0, stdout: JSON.stringify([{ uuid: '44444444-4444-4444-8444-444444444444', name: 'codeflare-integration-usage' }]) },
      'd1 migrations apply codeflare-integration-usage --remote': { status: 1, stderr: 'migration failed' },
    });
    await expect(prepareUsageD1({
      workerName: 'codeflare-integration', deployToken: 'deploy', runtimeToken: 'runtime', wranglerConfig: config, run: fake.run,
    })).rejects.toThrow('migration failed');
    expect(fake.calls).toHaveLength(2);
  });
});
