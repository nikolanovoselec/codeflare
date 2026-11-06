// CI/image-only qualification: no patching, private channels or credential companion.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const result = spawnSync(process.execPath, ['--test', 'host/__tests__/pi-mcp-stock.test.js', 'preseed/agents/pi/test/consult-proxy.test.mjs'],
  { cwd: root, stdio: 'inherit', timeout: 180_000 });
if (result.error || result.status !== 0) process.exitCode = 1;
