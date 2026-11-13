import { createHash } from 'node:crypto';

const deadline = Symbol('plan-rpc-deadline');
export async function bounded<T>(work: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(deadline), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}

function errorField(error: unknown, key: 'name' | 'message' | 'stack'): string | null {
  try {
    if (typeof error !== 'object' || error === null) return null;
    const value: unknown = Reflect.get(error, key);
    return typeof value === 'string' ? value : null;
  } catch { return null; }
}

/** Closed projection only: never return/stringify a raw exception or stack. */
export function projectError(error: unknown) {
  const name = errorField(error, 'name');
  const message = errorField(error, 'message');
  const stack = errorField(error, 'stack');
  const transportLost = /ProxyWorker|connection (?:lost|closed)|HTTP\s*500/i.test(message ?? '');
  return {
    kind: error === deadline ? 'deadline' : transportLost ? 'retired-transport'
      : name === 'TypeError' ? 'TypeError' : name === 'RangeError' ? 'RangeError'
      : name === 'Error' ? 'Error' : 'unclassified',
    messageDigest: message === null ? null : createHash('sha256')
      .update(Buffer.from(message.slice(0, 8192), 'utf8').subarray(0, 8192)).digest('hex'),
    messageTruncated: message !== null && (message.length > 8192 || Buffer.byteLength(message, 'utf8') > 8192),
    allowedOriginFrames: [...(stack?.slice(0, 16384).matchAll(
      /(?:src\/operators\/(?:activity|dispatcher-scheduler)\.ts|node_modules\/agents\/(?:src\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.ts|dist\/[A-Za-z0-9_-]+\.js)|node_modules\/\.vite\/deps\/agents(?:_lifecycle)?\.js):\d+:\d+/g,
    ) ?? [])].slice(0, 8).map(match => match[0]),
  };
}

export type PlanResult = { outcome: 'returned-null' | 'returned-non-null' | 'rejected'; error: ReturnType<typeof projectError> | null };
export const returned = (plan: unknown): PlanResult => ({
  outcome: plan === null ? 'returned-null' : 'returned-non-null', error: null,
});
export const rejected = (error: unknown): PlanResult => ({ outcome: 'rejected', error: projectError(error) });
export type AlarmResult = { alarmEntered: true; initialization: PlanResult | null; result: PlanResult };
