import type { OperatorBundle } from './distribution';

/** Minimal documented Worker Loader surface; no cached get() or inherited env. */
export interface OperatorLoaderBinding {
  load(code: {
    compatibilityDate: string;
    compatibilityFlags: string[];
    mainModule: string;
    modules: OperatorBundle['modules'];
    env: { OPERATOR: Fetcher };
    globalOutbound: Fetcher | null;
  }): { getEntrypoint(): Fetcher };
}

/** REQ-OPERATOR-003 loader boundary under TDD; no production binding yet. */
export function loadOperatorWorker(
  _loader: OperatorLoaderBinding,
  _bundle: OperatorBundle,
  _capability: Fetcher,
  _outbound: Fetcher | null,
): Fetcher {
  throw new Error('Operator Worker loading is not implemented');
}
