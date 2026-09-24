import { relative } from 'node:path';

// Vitest's module diagnostics include collection/import work that the JSON
// report's assertion durations omit. Log alongside the fail-closed JSON gate.
export default class BackendTimingReporter {
  onTestRunEnd(modules) {
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
