import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export type PiMemoryShutdown =
  | { status: 'exited'; count: number }
  | { status: 'timeout'; remaining: number }
  | { status: 'unconfirmed' };

type Owner = { pid: number; startTime: string; receipt: string };
const MAX_SHUTDOWN_MS = 20_000;
const MAX_RECEIPT_BYTES = 2048;
const MAX_OWNERS = 128;

function receipt(file: string): Pick<Owner, 'pid' | 'startTime'> {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const info = fs.fstatSync(fd);
    if (!info.isFile() || info.size > MAX_RECEIPT_BYTES || info.uid !== process.getuid?.()) throw new Error('invalid owner receipt');
    const buffer = Buffer.alloc(MAX_RECEIPT_BYTES + 1);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (size > MAX_RECEIPT_BYTES) throw new Error('oversized owner receipt');
    const value: unknown = JSON.parse(buffer.subarray(0, size).toString('utf8'));
    if (!value || typeof value !== 'object') throw new Error('invalid owner receipt');
    const { pid, startTime } = value as Record<string, unknown>;
    if (!Number.isSafeInteger(pid) || (pid as number) <= 1 || pid === process.pid
      || typeof startTime !== 'string' || !/^\d{1,32}$/.test(startTime)) throw new Error('invalid owner identity');
    return { pid: pid as number, startTime };
  } finally { fs.closeSync(fd); }
}

function identity(pid: number): { startTime: string; name: string; uid: number } | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const close = stat.lastIndexOf(')');
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    if (fields[0] === 'Z' || fields[0] === 'X') return null;
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const uid = status.match(/^Uid:\s+(\d+)/m)?.[1];
    if (close < 0 || !/^\d+$/.test(fields[19] ?? '') || uid === undefined) throw new Error('unavailable process identity');
    return { startTime: fields[19], name: stat.slice(stat.indexOf('(') + 1, close), uid: Number(uid) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function sameOwner(owner: Owner): boolean {
  const current = identity(owner.pid);
  if (!current) return false;
  if (current.startTime !== owner.startTime || current.name !== 'pi' || current.uid !== process.getuid?.()) {
    throw new Error('owner process changed');
  }
  return true;
}

function unchangedReceipt(owner: Owner): void {
  try {
    const current = receipt(owner.receipt);
    if (current.pid !== owner.pid || current.startTime !== owner.startTime) throw new Error('owner receipt changed');
  } catch (error) {
    // The owner's final shutdown handler removes its own receipt before exit.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

/** Stop registered foreground writers, never their process group or descendants. */
export async function shutdownPiMemoryOwners(ownersDir: string, deadline: number): Promise<PiMemoryShutdown> {
  const stopAt = Math.min(deadline, Date.now() + MAX_SHUTDOWN_MS);
  try {
    let names: string[];
    try {
      if (!fs.lstatSync(ownersDir).isDirectory()) return { status: 'unconfirmed' };
      names = fs.readdirSync(ownersDir).filter(name => name.endsWith('.json'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { status: 'exited', count: 0 };
      throw error;
    }
    if (names.length > MAX_OWNERS || !Number.isFinite(stopAt)) return { status: 'unconfirmed' };
    const owners: Owner[] = [];
    for (const name of names) {
      if (!/^[1-9]\d*\.json$/.test(name)) return { status: 'unconfirmed' };
      const file = path.join(ownersDir, name);
      const data = receipt(file);
      if (`${data.pid}.json` !== name) return { status: 'unconfirmed' };
      const owner = { ...data, receipt: file };
      if (sameOwner(owner)) owners.push(owner);
    }
    if (!owners.length) return { status: 'exited', count: 0 };
    if (Date.now() >= stopAt) return { status: 'timeout', remaining: owners.length };
    for (const owner of owners) {
      unchangedReceipt(owner);
      if (!sameOwner(owner)) continue;
      try { process.kill(owner.pid, 'SIGTERM'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    }
    let pending = owners;
    for (;;) {
      pending = pending.filter(owner => {
        unchangedReceipt(owner);
        return sameOwner(owner);
      });
      if (!pending.length) return { status: 'exited', count: owners.length };
      const remaining = stopAt - Date.now();
      if (remaining <= 0) return { status: 'timeout', remaining: pending.length };
      await delay(Math.min(25, remaining));
    }
  } catch {
    return { status: 'unconfirmed' };
  }
}
