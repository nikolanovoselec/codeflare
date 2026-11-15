import { relative } from 'node:path';
import { Session } from 'node:inspector';
import { promisify } from 'node:util';

// Vitest's module diagnostics include collection/import work that the JSON
// report's assertion durations omit. Log alongside the fail-closed JSON gate.
export default class BackendTimingReporter {
  async onInit() {
    // Weighted files can move between Workers shards; no number owns the stall.
    if (!process.env.NAME?.startsWith('backend-shard-')) return;
    try {
      this.cpuSession = new Session();
      this.cpuSession.connect();
      this.cpuPost = promisify(this.cpuSession.post.bind(this.cpuSession));
      await this.cpuPost('Profiler.enable');
      await this.cpuPost('Profiler.setSamplingInterval', { interval: 10000 });
      await this.cpuPost('Profiler.start');
      this.cpuTimer = setInterval(() => { void this.flushCpu(); }, 30000);
      this.cpuTimer.unref();
    } catch (error) {
      this.cpuError(error);
    }
  }

  // Emit before hooks and immediately after each result, not only at run end:
  // a forcibly terminated suite must leave its active case and first failure.
  // Only test identity/state cross this diagnostic wire, never errors or payloads.
  testProgress(testCase, phase, state) {
    process.stdout.write(`\nBACKEND_TEST ${JSON.stringify({
      phase,
      file: relative(process.cwd(), testCase.module.moduleId).replaceAll('\\', '/'),
      id: testCase.id,
      name: testCase.fullName,
      ...(state ? { state } : {}),
    })}\n`);
  }

  onTestCaseReady(testCase) {
    this.testProgress(testCase, 'start');
  }

  onTestCaseResult(testCase) {
    this.testProgress(testCase, 'finish', testCase.result().state);
  }

  cpuError(error) {
    process.stdout.write(`BACKEND_CPU_ERROR ${JSON.stringify({ code: error?.code ?? 'profile-failed' })}\n`);
    this.cpuSession?.disconnect();
    this.cpuPost = undefined;
    clearInterval(this.cpuTimer);
  }

  flushCpu() {
    if (!this.cpuPost || this.cpuFlush) return this.cpuFlush;
    this.cpuFlush = this.captureCpu().catch(error => this.cpuError(error)).finally(() => {
      this.cpuFlush = undefined;
      if (this.cpuFinished) this.cpuSession?.disconnect();
    });
    return this.cpuFlush;
  }

  async captureCpu() {
    const { profile } = await this.cpuPost('Profiler.stop');
    const nodes = new Map(profile.nodes.map(node => [node.id, node]));
    const parents = new Map(profile.nodes.flatMap(node => (node.children ?? []).map(id => [id, node.id])));
    const hits = new Map();
    for (const id of profile.samples ?? []) hits.set(id, (hits.get(id) ?? 0) + 1);
    const frame = id => {
      const call = nodes.get(id).callFrame;
      // Never publish data URLs, query strings, process arguments or payloads.
      const url = call.url.startsWith('file:') || call.url.startsWith('node:')
        ? call.url.split(/[?#]/, 1)[0].replace(process.cwd(), '[workspace]') : '(runtime)';
      return { function: call.functionName, url, line: call.lineNumber + 1 };
    };
    const hot = [...hits].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([id, samples]) => {
      const callers = [];
      let parent = parents.get(id);
      for (let depth = 0; parent !== undefined && depth < 4; depth++) {
        callers.push(frame(parent));
        parent = parents.get(parent);
      }
      return { ...frame(id), samples, callers };
    });
    process.stdout.write(`BACKEND_CPU ${JSON.stringify({ at: new Date().toISOString(),
      windowMs: (profile.endTime - profile.startTime) / 1000, cpu: process.cpuUsage(), hot })}\n`);
    if (!this.cpuFinished) await this.cpuPost('Profiler.start');
  }

  async onTestRunEnd(modules) {
    this.cpuFinished = true;
    clearInterval(this.cpuTimer);
    await this.flushCpu();
    for (const module of modules) {
      const diagnostic = module.diagnostic();
      const componentsMs = {
        environment: diagnostic.environmentSetupDuration,
        prepare: diagnostic.prepareDuration,
        collect: diagnostic.collectDuration,
        setup: diagnostic.setupDuration,
        tests: diagnostic.duration,
      };
      const totalMs = Object.values(componentsMs).reduce((sum, value) => sum + value, 0);
      process.stdout.write(`BACKEND_TIMING ${JSON.stringify({
        file: relative(process.cwd(), module.moduleId).replaceAll('\\', '/'),
        totalMs,
        componentsMs,
      })}\n`);
    }
  }
}
