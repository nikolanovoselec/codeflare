import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const TOOLS = Object.freeze(['zizmor', 'actionlint']);
const VERSION = /^\d+\.\d+\.\d+$/;
const SHA256 = /^[0-9a-f]{64}$/;
const DEFAULT_PATH = resolve('.github/workflow-tool-pins.json');

function validatePins(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('workflow tool pins must be an object');
  }
  const keys = Object.keys(value);
  if (keys.length !== TOOLS.length || TOOLS.some((tool) => !keys.includes(tool))) {
    throw new Error(`workflow tool pins must contain exactly: ${TOOLS.join(', ')}`);
  }
  for (const tool of TOOLS) {
    const pin = value[tool];
    if (!pin || typeof pin !== 'object' || Array.isArray(pin) || Object.keys(pin).sort().join(',') !== 'sha256,version') {
      throw new Error(`${tool} pin must contain exactly version and sha256`);
    }
    if (!VERSION.test(pin.version)) throw new Error(`invalid version for ${tool}: ${pin.version}`);
    if (!SHA256.test(pin.sha256)) throw new Error(`invalid sha256 for ${tool}`);
  }
  return value;
}

function readPins(path) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`could not read workflow tool pins from ${path}: ${error.message}`);
  }
  return validatePins(parsed);
}

export function readWorkflowToolPin(path, tool) {
  if (!TOOLS.includes(tool)) throw new Error(`unsupported workflow tool: ${tool}`);
  return { ...readPins(path)[tool] };
}

export function updateWorkflowToolPin(path, tool, expectedVersion, nextVersion, nextSha256) {
  const pins = readPins(path);
  if (!TOOLS.includes(tool)) throw new Error(`unsupported workflow tool: ${tool}`);
  if (pins[tool].version !== expectedVersion) {
    throw new Error(`expected ${tool} ${expectedVersion}, found ${pins[tool].version}`);
  }
  if (!VERSION.test(nextVersion)) throw new Error(`invalid version for ${tool}: ${nextVersion}`);
  if (!SHA256.test(nextSha256)) throw new Error(`invalid sha256 for ${tool}`);

  const updated = {
    ...pins,
    [tool]: {
      version: nextVersion,
      sha256: nextSha256,
    },
  };
  validatePins(updated);
  writeFileSync(path, `${JSON.stringify(updated, null, 2)}\n`);
}

function usage() {
  return 'usage: workflow-tool-pins.mjs get <tool> <version|sha256> [path] | update <tool> <expected-version> <next-version> <sha256> [path]';
}

function main(argv) {
  const [command, tool, ...args] = argv;
  if (command === 'get' && args.length >= 1 && args.length <= 2) {
    const [field, path = DEFAULT_PATH] = args;
    if (field !== 'version' && field !== 'sha256') throw new Error(usage());
    process.stdout.write(`${readWorkflowToolPin(resolve(path), tool)[field]}\n`);
    return;
  }
  if (command === 'update' && args.length >= 3 && args.length <= 4) {
    const [expectedVersion, nextVersion, nextSha256, path = DEFAULT_PATH] = args;
    updateWorkflowToolPin(resolve(path), tool, expectedVersion, nextVersion, nextSha256);
    return;
  }
  throw new Error(usage());
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
