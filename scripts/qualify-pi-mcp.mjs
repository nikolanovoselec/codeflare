// CI/image-only qualification: unmodified pi-mcp-adapter 5.3.1 on Pi 1.5.0.
// Keep the historical portal-test filename and the independent stdio consult suite.
// No patching, private channels, credential companion or local long-wait qualification.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../', import.meta.url));
const result = spawnSync(process.execPath, ['--test', 'host/__tests__/pi-mcp-stock.test.js', 'preseed/agents/pi/test/consult-proxy.test.mjs'],
  { cwd: root, stdio: 'inherit', timeout: 180_000 });
if (result.error || result.status !== 0) process.exitCode = 1;
