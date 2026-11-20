import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, chmodSync, linkSync, lstatSync, realpathSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

// Build-time only: both payloads must be newly installed in the SAME image layer.
// Keep the official extension's bytes, executable mode and pathname unchanged.
export async function shareClaudeNative(cli, official) {
  const source = realpathSync(cli), from = lstatSync(source), to = lstatSync(official);
  const mode = to.mode & 0o777;
  if (!from.isFile() || !to.isFile() || !(mode & 0o111) || (mode & 0o222)
      || from.uid !== to.uid || from.gid !== to.gid || from.dev !== to.dev
      || (from.mode & 0o555) !== mode) throw new Error('Incompatible native payload metadata');
  if (from.ino === to.ino) return { shared: true, bytesSaved: 0 };
  if (to.nlink !== 1) return { shared: false, bytesSaved: 0, reason: 'official-payload-already-linked' };
  if (from.size !== to.size || await sha256(source) !== await sha256(official)) {
    return { shared: false, bytesSaved: 0, reason: 'different-payloads' };
  }
  const temporary = join(dirname(official), `.shared-claude-${randomUUID()}`);
  try {
    linkSync(source, temporary);
    // All CLI aliases share the same immutable executable; no executable bytes change.
    chmodSync(source, mode);
    renameSync(temporary, official);
  } finally { rmSync(temporary, { force: true }); }
  return { shared: true, bytesSaved: to.size };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { console.log(JSON.stringify(await shareClaudeNative(process.argv[2], process.argv[3]))); }
  catch { console.error('Claude native payload sharing failed'); process.exitCode = 1; }
}
