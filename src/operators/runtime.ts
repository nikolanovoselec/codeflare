/**
 * Activity-to-Worker drive composition
 * Reserve a durable generation, bind/load fresh code, bound the response, then commit through the
 * activity owner. Failures fence uncertain work instead of replaying business effects.
 * Request abort and generation fencing are not evidence that external compute has stopped.
 * See sdd/spec/operators.md and documentation/lanes/operators.md for acceptance boundaries.
 */
import type { OperatorActivity, OperatorDriveResult } from './activity';
import type { DispatcherBundle, OperatorBundle } from './distribution';
import { loadOperatorWorker, type OperatorLoaderBinding } from './loader';

/** Parent-selected activity/artifact and generation-bound capability construction. */
interface OperatorRuntimeOptions {
  activity: Pick<OperatorActivity, 'beginDrive' | 'commitDrive' | 'interruptDrive'>;
  activityId: string;
  deadline: number;
  expectedGeneration?: number;
  loader: OperatorLoaderBinding;
  bundle: OperatorBundle;
  invocation?: unknown;
  bind: (generation: number, driveDeadline: number) => { capability: Fetcher; outbound: Fetcher | null }
    | Promise<{ capability: Fetcher; outbound: Fetcher | null }>;
}

/** REQ-OPERATOR-048: reserve once; asynchronous admission never manufactures a checkpoint. */
export async function driveDispatcherRuntime(options: {
  activity: Pick<OperatorActivity, 'beginDrive' | 'admitDispatcher' | 'interruptDrive'>;
  deadline: number; bundle: DispatcherBundle; artifactDigest: string; invocation: unknown;
  expectedGeneration?: number;
}): Promise<OperatorDriveResult> {
  if (!Number.isFinite(options.deadline) || Date.now() >= options.deadline) {
    return { ok: false, reason: 'authority-expired' };
  }
  const reserved = await options.activity.beginDrive(options.expectedGeneration);
  if (!reserved.ok) return reserved;
  try {
    return await options.activity.admitDispatcher(reserved.state.generation,
      options.bundle, options.artifactDigest, options.invocation);
  } catch {
    return options.activity.interruptDrive(reserved.state.generation);
  }
}

/**
 * REQ-OPERATOR-018: Compose durable drive reservation with a fresh approved Worker.
 * The authorized parent supplies the pinned artifact and creates capabilities
 * bound to the returned generation. No credentials enter the versioned request.
 * Bounded child output is committed only through the activity's generation check.
 * Failures fence uncertain work; no business operation is automatically retried.
 * Cancellation/expiry fencing is not proof that owned session cleanup completed.
 */
export async function driveOperatorRuntime(options: OperatorRuntimeOptions): Promise<OperatorDriveResult> {
  if (!Number.isFinite(options.deadline) || Date.now() >= options.deadline) {
    return { ok: false, reason: 'authority-expired' };
  }
  const reserved = await options.activity.beginDrive(options.expectedGeneration);
  if (!reserved.ok) return reserved;
  const { generation, checkpoint } = reserved.state;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let response: Response | undefined;
  let consumed = false;
  try {
    const driveDeadline = Math.min(options.deadline, Date.now() + 30_000);
    const remaining = driveDeadline - Date.now();
    if (remaining <= 0) throw new Error('Expired drive');
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('Drive deadline exceeded'));
      }, remaining);
    });
    const execute = async () => {
      const bindings = await options.bind(generation, driveDeadline);
      const worker = loadOperatorWorker(options.loader, options.bundle, bindings.capability, bindings.outbound);
      response = await worker.fetch(new Request('https://operator.internal/drive', {
        method: 'POST', signal: controller.signal, headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ schemaVersion: 1, action: generation === 1 ? 'start' : 'resume',
          activityId: options.activityId, generation, checkpoint, invocation: options.invocation ?? null }),
      }));
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => {});
        throw new Error('Expired runtime response');
      }
      if (response.status !== 200 || !response.body
        || response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
        throw new Error('Invalid runtime response');
      }
      reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > 64 * 1024 || controller.signal.aborted) throw new Error('Runtime response exceeded bounds');
        chunks.push(chunk.value);
      }
      consumed = true;
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)) as unknown;
    };
    const update = await Promise.race([execute(), timeout]);
    if (controller.signal.aborted || Date.now() >= driveDeadline) throw new Error('Expired drive');
    const result = await options.activity.commitDrive(generation, update);
    if (!result.ok && (result.reason === 'invalid-update' || result.reason === 'authority-expired')) {
      return await options.activity.interruptDrive(generation);
    }
    return result;
  } catch {
    return await options.activity.interruptDrive(generation);
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (!consumed) {
      if (reader) void reader.cancel().catch(() => {});
      else if (response?.body) void response.body.cancel().catch(() => {});
    }
    reader?.releaseLock();
  }
}
