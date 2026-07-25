import { readdir, readFile } from 'node:fs/promises';

export const SIDEBAR_PROCESS_GENERATION_ENV = 'CODEFLARE_SIDEBAR_PROCESS_GENERATION';

export interface SidebarGenerationMember {
  readonly pid: number;
  readonly processGroup: number;
  readonly startTime: string;
}

export interface SidebarGenerationReapOptions {
  readonly termGraceMs?: number;
  readonly killGraceMs?: number;
  readonly pollMs?: number;
}

export async function listSidebarGenerationMembers(token: string): Promise<SidebarGenerationMember[]> {
  assertToken(token);
  const entries = await readdir('/proc', { withFileTypes: true });
  const members = await Promise.all(entries.flatMap((entry) => {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) return [];
    const pid = Number(entry.name);
    if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return [];
    return [readMember(pid, token)];
  }));
  return members
    .filter((member): member is SidebarGenerationMember => member !== undefined)
    .sort((left, right) => left.pid - right.pid);
}

export async function reapSidebarGeneration(
  token: string,
  options: SidebarGenerationReapOptions = {},
): Promise<void> {
  assertToken(token);
  const termGraceMs = boundedDuration(options.termGraceMs, 2_000);
  const killGraceMs = boundedDuration(options.killGraceMs, 2_000);
  const pollMs = boundedDuration(options.pollMs, 25, 1);

  if (await signalUntilEmpty(token, 'SIGTERM', termGraceMs, pollMs)) return;
  if (await signalUntilEmpty(token, 'SIGKILL', killGraceMs, pollMs)) return;
  throw new Error('Sidebar process generation did not terminate');
}

async function signalUntilEmpty(
  token: string,
  signal: NodeJS.Signals,
  graceMs: number,
  pollMs: number,
): Promise<boolean> {
  const deadline = Date.now() + graceMs;
  do {
    const members = await listSidebarGenerationMembers(token);
    if (members.length === 0) return true;
    await Promise.all(members.map((member) => signalIfSame(member, token, signal)));
    if (Date.now() >= deadline) break;
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  } while (true);
  return (await listSidebarGenerationMembers(token)).length === 0;
}

async function signalIfSame(
  expected: SidebarGenerationMember,
  token: string,
  signal: NodeJS.Signals,
): Promise<void> {
  const current = await readMember(expected.pid, token);
  if (!current || current.startTime !== expected.startTime) return;
  try {
    process.kill(expected.pid, signal);
  } catch (error) {
    if (!isMissingProcess(error)) throw error;
  }
}

async function readMember(pid: number, token: string): Promise<SidebarGenerationMember | undefined> {
  try {
    const [environment, stat] = await Promise.all([
      readFile(`/proc/${pid}/environ`),
      readFile(`/proc/${pid}/stat`, 'utf8'),
    ]);
    const expected = `${SIDEBAR_PROCESS_GENERATION_ENV}=${token}`;
    if (!environment.toString('utf8').split('\0').some((entry) => entry === expected)) {
      return undefined;
    }
    const close = stat.lastIndexOf(')');
    if (close < 0) return undefined;
    const fields = stat.slice(close + 2).trim().split(/\s+/);
    const processGroup = Number(fields[2]);
    const startTime = fields[19];
    if (!Number.isSafeInteger(processGroup) || processGroup <= 0 || !startTime) return undefined;
    return { pid, processGroup, startTime };
  } catch (error) {
    if (isMissingProcess(error) || isPermissionDenied(error)) return undefined;
    throw error;
  }
}

function boundedDuration(value: number | undefined, fallback: number, minimum = 0): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > 30_000) {
    throw new Error('Invalid process-generation timeout');
  }
  return value;
}

function assertToken(token: string): void {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(token)) throw new Error('Invalid process-generation token');
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function isMissingProcess(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ESRCH' || code === 'ENOENT';
}

function isPermissionDenied(error: unknown): boolean {
  if (!(error instanceof Error) || !('code' in error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'EACCES' || code === 'EPERM';
}
