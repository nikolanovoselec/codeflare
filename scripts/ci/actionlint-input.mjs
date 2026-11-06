// actionlint 1.7.12 predates GitHub's self-repository syntax. Only its input view changes;
// zizmor and GitHub consume the original files. Remove/requalify this bridge on a pin change.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isMap, isScalar, isSeq, parseDocument } from 'yaml';
import { readWorkflowToolPin } from './workflow-tool-pins.mjs';

export function actionlintInput(source, version) {
  if (version !== '1.7.12') throw new Error('Requalify the actionlint syntax bridge for this version');
  const document = parseDocument(source);
  if (document.errors.length) throw new Error('Invalid workflow YAML');
  const jobs = document.get('jobs', true);
  if (!isMap(jobs)) throw new Error('Workflow jobs must be a mapping');
  const offsets = [];
  function project(node, kind) {
    if (node === undefined) return;
    if (!isScalar(node) || typeof node.value !== 'string') throw new Error('Unsupported workflow uses shape');
    if (!node.value.startsWith('$/')) return;
    const pattern = kind === 'workflow'
      ? /^\$\/\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/
      : /^\$\/\.github\/actions\/[A-Za-z0-9_./-]+$/;
    if (!pattern.test(node.value) || node.value.split('/').slice(1).some(part => !part || part === '.' || part === '..')) {
      throw new Error('Unsupported self-repository target');
    }
    if (!['PLAIN', 'QUOTE_SINGLE', 'QUOTE_DOUBLE'].includes(node.type)) throw new Error('Unsupported uses scalar');
    const offset = node.range[0] + (node.type === 'PLAIN' ? 0 : 1);
    if (source.slice(offset, offset + 2) !== '$/') throw new Error('Unsupported escaped uses scalar');
    offsets.push(offset);
  }
  for (const { value: job } of jobs.items) {
    if (!isMap(job)) throw new Error('Unsupported workflow job shape');
    project(job.get('uses', true), 'workflow');
    const steps = job.get('steps', true);
    if (steps === undefined) continue;
    if (!isSeq(steps)) throw new Error('Unsupported workflow steps shape');
    for (const step of steps.items) {
      if (!isMap(step)) throw new Error('Unsupported workflow step shape');
      project(step.get('uses', true), 'action');
    }
  }
  const input = source.split('');
  for (const offset of offsets) input[offset] = '.';
  return input.join('');
}

function runActionlint(binary, files, version) {
  if (!binary || !files.length) throw new Error('Actionlint binary and workflow files are required');
  let status = 0;
  for (const file of files) {
    const bytes = readFileSync(file);
    const source = bytes.toString('utf8');
    if (!Buffer.from(source, 'utf8').equals(bytes)) throw new Error('Workflow must be valid UTF-8');
    const input = actionlintInput(source, version);
    const result = spawnSync(binary, ['-color', '-pyflakes=', '-stdin-filename', file, '-'], {
      input, stdio: ['pipe', 'inherit', 'inherit'],
    });
    if (result.error) throw result.error;
    if (result.signal) throw new Error(`Actionlint terminated by ${result.signal}`);
    if (result.status !== 0) status = result.status ?? 1;
  }
  return status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const version = readWorkflowToolPin(new URL('../../.github/workflow-tool-pins.json', import.meta.url), 'actionlint').version;
    const [binary, ...files] = process.argv.slice(2);
    process.exitCode = runActionlint(binary, files, version);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
