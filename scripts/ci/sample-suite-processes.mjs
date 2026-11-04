import { execFileSync } from 'node:child_process';

// Observe only this suite's descendants and its owning runner. Never read argv,
// environment values, application payloads or unrelated jobs' process details.
const root = Number(process.argv[2]);
if (!Number.isSafeInteger(root) || root <= 1 || root !== process.ppid) {
  throw new Error('Sampler requires its owning suite shell PID');
}

function snapshot() {
  try {
    const text = execFileSync('ps', ['-eo', 'pid=,ppid=,comm=,state=,time=,rss=,wchan='], {
      encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024,
    });
    const rows = text.trim().split('\n').flatMap(line => {
      const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s+(\S+)\s+(\S+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
      return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), name: match[3],
        state: match[4], cpuTime: match[5], rssKiB: Number(match[6]), wchan: match[7] }] : [];
    });
    const parents = new Map(rows.map(row => [row.pid, row.ppid]));
    const descendant = pid => {
      while (pid !== root && parents.has(pid)) pid = parents.get(pid);
      return pid === root;
    };
    const ancestors = new Set();
    for (let pid = root; parents.has(pid); pid = parents.get(pid)) ancestors.add(pid);
    const processes = rows.flatMap(row => {
      const runner = row.name === 'Runner.Worker' && ancestors.has(row.pid);
      if (row.pid === process.pid || (!runner && !descendant(row.pid))) return [];
      const name = runner ? 'Runner.Worker' : /^workerd/.test(row.name) ? 'workerd'
        : /^(?:node|npm|vitest)/.test(row.name) ? 'node' : row.name === 'tee' ? 'tee' : undefined;
      return name ? [{ pid: row.pid, ppid: row.ppid, name, state: row.state,
        cpuTime: row.cpuTime, rssKiB: row.rssKiB, wchan: row.wchan }] : [];
    });
    process.stdout.write(`BACKEND_PROCESS_CPU ${JSON.stringify({ at: new Date().toISOString(), processes })}\n`);
  } catch (error) {
    process.stdout.write(`BACKEND_PROCESS_CPU_ERROR ${JSON.stringify({ code: error?.code ?? 'snapshot-failed' })}\n`);
  }
}

snapshot();
setInterval(snapshot, 20000);
