import type { OperatorActivity, OperatorDriveResult } from './activity';
import type { OperatorBundle } from './distribution';
import type { OperatorLoaderBinding } from './loader';

/** Parent-selected activity/artifact and generation-bound capability construction. */
interface OperatorRuntimeOptions {
  activity: Pick<OperatorActivity, 'beginDrive' | 'commitDrive' | 'interruptDrive'>;
  activityId: string;
  deadline: number;
  loader: OperatorLoaderBinding;
  bundle: OperatorBundle;
  bind: (generation: number) => { capability: Fetcher; outbound: Fetcher | null };
}

/** REQ-OPERATOR-003 activity/Worker composition under behavioral TDD. */
export async function driveOperatorRuntime(_options: OperatorRuntimeOptions): Promise<OperatorDriveResult> {
  throw new Error('Operator runtime driver is not implemented');
}
