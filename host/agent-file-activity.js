import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

async function defaultGetDirSize(dir) {
  try {
    const { stdout } = await execFileAsync('du', ['-s', dir]);
    const size = parseInt(stdout.split('\t')[0], 10);
    return isNaN(size) ? 0 : size;
  } catch {
    return 0;
  }
}

function createAgentFileChecker(dirs) {
  return {
    dirs,
    previousSnapshot: new Map(),
    _getDirSize: defaultGetDirSize,
  };
}

async function checkAgentFileActivity(checker) {
  const currentSizes = new Map();

  await Promise.all(
    checker.dirs.map(async (dir) => {
      try {
        const size = await checker._getDirSize(dir);
        currentSizes.set(dir, size);
      } catch {
        currentSizes.set(dir, 0);
      }
    })
  );

  let changed = false;
  if (checker.previousSnapshot.size > 0) {
    for (const [dir, size] of currentSizes) {
      const prev = checker.previousSnapshot.get(dir) ?? 0;
      if (size !== prev) {
        changed = true;
        break;
      }
    }
  }

  checker.previousSnapshot = new Map(currentSizes);
  return changed;
}

export { createAgentFileChecker, checkAgentFileActivity };
