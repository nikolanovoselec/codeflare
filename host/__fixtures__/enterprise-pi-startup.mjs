import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const nativeHandle = 'cf-native-99c2c827-dd91-4093-b181-918a1c773944';
export const authorizedRoutes = ['bedrock_opus', nativeHandle];
export const nativeLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
export const siblingProvider = { api: 'openai-completions', baseUrl: 'https://example.invalid/v1', apiKey: 'fixture-only', models: [{ id: 'unrelated', name: 'Unrelated' }] };

export function extractEnterpriseBlock(entrypoint) {
  const section = entrypoint.indexOf('# Gated strictly on ENTERPRISE_MODE=active');
  const start = entrypoint.indexOf('if [ "${ENTERPRISE_MODE:-}" = "active" ]; then', section);
  const end = entrypoint.indexOf('\nfi\n\n# --- TLS: trust the Cloudflare containers CA for NON-ENTERPRISE OAuth sessions ---', start);
  if (section < 0 || start < 0 || end < 0) throw new Error('Enterprise startup markers not found');
  return entrypoint.slice(start, end + '\nfi\n'.length);
}

// Run the real outer startup boundary, including environment initialization, against
// restored files. No agent is launched and no provider/network request is made.
export function enterpriseStartup({ reasoning, levels = { bedrock_opus: [], [nativeHandle]: nativeLevels } } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'enterprise-pi-startup-'));
  const agentDir = join(home, '.pi/agent');
  mkdirSync(agentDir, { recursive: true });
  const modelsPath = join(agentDir, 'models.json');
  const settingsPath = join(agentDir, 'settings.json');
  writeFileSync(modelsPath, JSON.stringify({ providers: {
    'codeflare-gateway': { api: 'openai-completions', baseUrl: 'https://api.openai.com/v1', apiKey: 'codeflare-enterprise',
      models: ['general_usage', 'development'].map((id) => ({ id, name: id, reasoning: true })) },
    'unrelated-provider': siblingProvider,
  } }));
  writeFileSync(settingsPath, JSON.stringify({ defaultProvider: 'codeflare-gateway', defaultModel: 'development', defaultThinkingLevel: 'high', theme: 'dark' }));
  const entrypoint = readFileSync(new URL('../../entrypoint.sh', import.meta.url), 'utf8');
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, USER_HOME: home,
    ENTERPRISE_MODE: 'active', ENTERPRISE_ROUTE_CATALOG: JSON.stringify(authorizedRoutes),
    ENTERPRISE_DEFAULT_ROUTE: 'bedrock_opus', ENTERPRISE_ROUTE_REASONING_LEVELS: JSON.stringify(levels),
    ENTERPRISE_ROUTE_CONTEXT_WINDOWS: JSON.stringify({ bedrock_opus: 1048576, [nativeHandle]: 200000 }),
    ENTERPRISE_MODEL_DISPLAY_NAMES: JSON.stringify({ [nativeHandle]: 'bedrock-opus-5' }),
    ...(reasoning !== undefined && { ENTERPRISE_DEFAULT_REASONING: reasoning }),
  };
  const result = spawnSync('bash', ['-c', `set -euo pipefail\n${extractEnterpriseBlock(entrypoint)}`], { encoding: 'utf8', env });
  return { home, agentDir, modelsPath, settingsPath, result,
    readModels: () => JSON.parse(readFileSync(modelsPath, 'utf8')),
    readSettings: () => JSON.parse(readFileSync(settingsPath, 'utf8')),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}
