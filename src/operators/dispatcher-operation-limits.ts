/** Operator-owned capacity shared by every distinct Dispatcher journal reservation. */
export const DEFAULT_DISPATCHER_OPERATION_LIMIT = 1024;

export function dispatcherOperationLimit(policy?: { operationLimit?: number }): number {
  return policy?.operationLimit ?? DEFAULT_DISPATCHER_OPERATION_LIMIT;
}
