#!/usr/bin/env node
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { deploymentCredentialBoundary } from './deployment-credentials.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseJson(output, operation) {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`${operation} returned invalid JSON`);
  }
}

function renderBinding(config, databaseName, databaseId) {
  const blocks = [...config.matchAll(/\[\[d1_databases\]\][\s\S]*?(?=\n\[\[|\n\[(?!\[)|$)/g)];
  const usageBlocks = blocks.filter((match) => /^binding\s*=\s*"USAGE_DB"\s*$/m.test(match[0]));
  if (usageBlocks.length !== 1) throw new Error(`Wrangler config must contain exactly one USAGE_DB binding; found ${usageBlocks.length}`);
  const current = usageBlocks[0][0];
  const rendered = current
    .replace(/^database_name\s*=.*$/m, `database_name = "${databaseName}"`)
    .replace(/^database_id\s*=.*$/m, `database_id = "${databaseId}"`);
  if (!/^database_name\s*=/m.test(current) || !/^database_id\s*=/m.test(current)) {
    throw new Error('USAGE_DB binding must declare database_name and database_id placeholders');
  }
  return `${config.slice(0, usageBlocks[0].index)}${rendered}${config.slice(usageBlocks[0].index + current.length)}`;
}

export async function prepareUsageD1({
  workerName,
  deployToken,
  runtimeToken,
  wranglerConfig,
  run,
  writeConfig = async () => {},
}) {
  const credentials = deploymentCredentialBoundary(deployToken, runtimeToken);
  if (!workerName?.trim()) throw new Error('Worker name is required');
  const databaseName = `${workerName}-usage`;

  const listed = await run(['d1', 'list', '--json'], credentials.wranglerEnvironment);
  if (listed.status !== 0) throw new Error(`Could not list D1 databases — refusing to mutate: ${listed.stderr || listed.stdout || 'unknown error'}`);
  const databases = parseJson(listed.stdout || '[]', 'D1 list');
  if (!Array.isArray(databases)) throw new Error('D1 list returned an unexpected shape');
  const exact = databases.filter((database) => database?.name === databaseName);
  if (exact.length > 1) throw new Error(`D1 list contains duplicate exact database name ${databaseName}`);

  let database = exact[0];
  let created = false;
  if (!database) {
    const creation = await run(['d1', 'create', databaseName, '--json'], credentials.wranglerEnvironment);
    if (creation.status !== 0) throw new Error(`Could not create D1 database ${databaseName}: ${creation.stderr || creation.stdout || 'unknown error'}`);
    database = parseJson(creation.stdout || '{}', 'D1 create');
    created = true;
  }
  const databaseId = database?.uuid;
  if (typeof databaseId !== 'string' || !UUID.test(databaseId)) throw new Error(`D1 database ${databaseName} has no valid UUID`);

  const rendered = renderBinding(wranglerConfig, databaseName, databaseId);
  await writeConfig(rendered);

  const types = await run(['types'], credentials.wranglerEnvironment);
  if (types.status !== 0) throw new Error(`Worker binding type generation failed: ${types.stderr || types.stdout || 'unknown error'}`);
  const migration = await run(['d1', 'migrations', 'apply', databaseName, '--remote'], credentials.wranglerEnvironment);
  if (migration.status !== 0) throw new Error(`D1 migration failed: ${migration.stderr || migration.stdout || 'unknown error'}`);

  return { databaseId, databaseName, created, wranglerConfig: rendered };
}

async function runWrangler(args, environment = {}) {
  return new Promise((resolve) => {
    const child = spawn('npx', ['wrangler', ...args], { env: { ...process.env, ...environment }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (status) => resolve({ status: status ?? 1, stdout, stderr }));
  });
}

async function main() {
  const configPath = process.argv[2] || 'wrangler.toml';
  const result = await prepareUsageD1({
    workerName: process.env.WORKER_NAME,
    deployToken: process.env.CLOUDFLARE_API_TOKEN,
    runtimeToken: process.env.RUNTIME_CLOUDFLARE_API_TOKEN,
    wranglerConfig: await readFile(configPath, 'utf8'),
    run: runWrangler,
    writeConfig: (content) => writeFile(configPath, content),
  });
  process.stdout.write(`${JSON.stringify({ databaseName: result.databaseName, databaseId: result.databaseId, created: result.created })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
