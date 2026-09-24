/** Session-bound Review evidence is data, never an execution principal or Review policy. */
export interface BoundaryInput {
  repositoryId: number;
  pullRequest: number;
  acknowledgedHead: string | null;
  targetHead: string;
  payload: Record<string, unknown>;
}

const SHA = /^[a-f0-9]{40}$/i;
const FIELDS = ['repositoryId', 'pullRequest', 'acknowledgedHead', 'targetHead', 'payload'];

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

/** Staging accepts bounded data; it does not assert a repository, ancestry or principal. */
export function parseBoundedBoundaryInput(value: unknown): BoundaryInput {
  if (!record(value) || Object.keys(value).length !== FIELDS.length
    || FIELDS.some(field => !Object.hasOwn(value, field))
    || typeof value.repositoryId !== 'number' || !Number.isSafeInteger(value.repositoryId) || value.repositoryId <= 0
    || typeof value.pullRequest !== 'number' || !Number.isSafeInteger(value.pullRequest) || value.pullRequest <= 0
    || typeof value.targetHead !== 'string' || !SHA.test(value.targetHead) || !record(value.payload)
    || (value.acknowledgedHead !== null
      && (typeof value.acknowledgedHead !== 'string' || !SHA.test(value.acknowledgedHead)
        || value.acknowledgedHead === value.targetHead))) {
    throw new Error('Invalid PR boundary input');
  }
  let serialized: string;
  try { serialized = JSON.stringify(value); }
  catch { throw new Error('Invalid PR boundary input'); }
  if (new TextEncoder().encode(serialized).length > 64 * 1024) throw new Error('Oversized PR boundary input');
  return value as unknown as BoundaryInput;
}

/** Independently verify staged input against current GitHub context before preparing anything. */
export async function verifyBoundedBoundaryInput(
  value: unknown,
  context: { repositoryId: number; pullRequest: number; head: string },
  isAncestor: (acknowledgedHead: string, targetHead: string) => Promise<boolean> | boolean,
): Promise<BoundaryInput> {
  const input = parseBoundedBoundaryInput(value);
  if (input.repositoryId !== context.repositoryId || input.pullRequest !== context.pullRequest
    || input.targetHead !== context.head) throw new Error('PR boundary does not match GitHub');
  if (input.acknowledgedHead !== null && !await isAncestor(input.acknowledgedHead, input.targetHead)) {
    throw new Error('Acknowledged head is not an ancestor of the PR head');
  }
  return input;
}
