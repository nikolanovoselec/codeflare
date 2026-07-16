function indentation(line) {
  return /^ */.exec(line)?.[0].length ?? 0;
}

function scalar(value) {
  const trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function property(line, expectedIndent) {
  if (indentation(line) !== expectedIndent) return undefined;
  const match = /^\s*([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(line);
  return match ? { key: match[1], value: match[2] ?? '' } : undefined;
}

export function executableLines(run = '') {
  return run
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('//'));
}

export function parseGitHubWorkflow(source) {
  const lines = source.replace(/\r\n?/g, '\n').split('\n');
  const jobsStart = lines.findIndex((line) => line === 'jobs:');
  if (jobsStart < 0) throw new Error('workflow is missing top-level jobs');

  const jobs = new Map();
  let currentJob;
  let inSteps = false;
  let currentStep;

  for (let index = jobsStart + 1; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const indent = indentation(line);
    if (indent === 0) break;

    const jobMatch = /^  ([a-z0-9-]+):\s*$/.exec(line);
    if (jobMatch) {
      if (jobs.has(jobMatch[1])) throw new Error(`duplicate workflow job: ${jobMatch[1]}`);
      currentJob = { runsOn: undefined, steps: [] };
      jobs.set(jobMatch[1], currentJob);
      currentStep = undefined;
      inSteps = false;
      continue;
    }
    if (!currentJob) throw new Error(`workflow content appears outside a job at line ${index + 1}`);

    const jobProperty = property(line, 4);
    if (jobProperty) {
      if (jobProperty.key === 'runs-on') {
        currentJob.runsOn = scalar(jobProperty.value);
        continue;
      }
      if (jobProperty.key === 'steps' && jobProperty.value === '') {
        inSteps = true;
        currentStep = undefined;
        continue;
      }
      throw new Error(`unsupported job field ${jobProperty.key} at line ${index + 1}; expected runs-on or steps`);
    }
    if (!inSteps) throw new Error(`job is missing steps before line ${index + 1}`);

    const stepMatch = /^      -\s+([A-Za-z0-9_-]+):(?:\s*(.*))?$/.exec(line);
    if (stepMatch) {
      currentStep = {};
      currentJob.steps.push(currentStep);
      const key = stepMatch[1];
      if (!['name', 'id', 'if', 'uses', 'run'].includes(key)) {
        throw new Error(`unsupported step field ${key} at line ${index + 1}`);
      }
      currentStep[key] = scalar(stepMatch[2] ?? '');
      continue;
    }
    if (!currentStep) throw new Error(`step property appears before a step at line ${index + 1}`);

    const stepProperty = property(line, 8);
    if (stepProperty) {
      if (stepProperty.key === 'run') {
        if (stepProperty.value !== '|') throw new Error(`run must use a block scalar at line ${index + 1}`);
        const run = [];
        while (index + 1 < lines.length) {
          const candidate = lines[index + 1];
          if (candidate.trim() && indentation(candidate) < 10) break;
          index += 1;
          run.push(candidate.length >= 10 ? candidate.slice(10) : '');
        }
        currentStep.run = run.join('\n');
        continue;
      }
      if (['name', 'id', 'if', 'uses'].includes(stepProperty.key)) {
        currentStep[stepProperty.key] = scalar(stepProperty.value);
        continue;
      }
      if (['env', 'with'].includes(stepProperty.key) && stepProperty.value === '') continue;
      throw new Error(`unsupported step field ${stepProperty.key} at line ${index + 1}`);
    }
    if (indent < 10) throw new Error(`malformed workflow structure at line ${index + 1}`);
  }

  if (jobs.size === 0) throw new Error('workflow has no jobs');
  for (const [name, job] of jobs) {
    if (!job.runsOn) throw new Error(`workflow job ${name} is missing runs-on`);
    if (job.steps.length === 0) throw new Error(`workflow job ${name} is missing steps`);
    const ids = job.steps.flatMap((step) => step.id ? [step.id] : []);
    if (new Set(ids).size !== ids.length) throw new Error(`workflow job ${name} has duplicate step ids`);
    for (const step of job.steps) {
      if (!step.uses && !step.run) throw new Error(`workflow job ${name} has a step without uses or run`);
    }
  }

  return { jobs };
}
