/** Distribution input boundary under behavioral TDD; not wired to production. */
export function parseOperatorManifest(_json: string, _endpoint: string): unknown {
  throw new Error('Operator discovery validation is not implemented');
}

/** Approved bundle boundary under behavioral TDD; never evaluates source. */
export async function parseOperatorBundle(_bytes: Uint8Array, _digest: string): Promise<unknown> {
  throw new Error('Operator bundle validation is not implemented');
}
