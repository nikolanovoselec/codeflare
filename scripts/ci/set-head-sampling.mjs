import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const FULL_LOG_ENVIRONMENTS = new Set(['integration', 'enterprise integration']);
const SAMPLED_LOG_ENVIRONMENTS = new Set(['production', 'enterprise']);

export function setHeadSampling(source, environment) {
  let rate;
  if (FULL_LOG_ENVIRONMENTS.has(environment)) rate = 1;
  else if (SAMPLED_LOG_ENVIRONMENTS.has(environment)) rate = 0.05;
  else throw new Error(`Unknown deployment environment: ${environment}`);
  const pattern = /^head_sampling_rate\s*=\s*[0-9.]+$/m;
  if (!pattern.test(source)) throw new Error('wrangler.toml is missing head_sampling_rate');
  return source.replace(pattern, `head_sampling_rate = ${rate}`);
}

async function main() {
  const [configPath, environment] = process.argv.slice(2);
  if (!configPath || !environment) throw new Error('Usage: set-head-sampling.mjs <wrangler.toml> <environment>');
  const source = await readFile(configPath, 'utf8');
  await writeFile(configPath, setHeadSampling(source, environment));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
