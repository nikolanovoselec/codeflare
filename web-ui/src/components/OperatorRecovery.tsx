import { For, Show, createSignal, createUniqueId, onCleanup, type Component } from 'solid-js';
import { ApiError } from '../api/fetch-helper';
import { APPLICATION_RECOVERY_BATCH_SIZE, previewApplicationRecovery, resetApplicationRecovery,
  type ApplicationDefinition, type ApplicationRecoveryItem, type ApplicationRecoveryResetInput } from '../api/operator-management';

interface Props {
  installationId: string;
  revision: number;
  recovery: NonNullable<ApplicationDefinition['recovery']>;
  blocked?: boolean;
  onPending?: (pending: boolean) => void;
}

/** Recovery is package-declared. Only reviewed key/version pairs may be submitted. */
const OperatorRecovery: Component<Props> = props => {
  const id = createUniqueId();
  const [open, setOpen] = createSignal(false);
  const [pending, setPending] = createSignal(false);
  const [items, setItems] = createSignal<ApplicationRecoveryItem[]>([]);
  const [next, setNext] = createSignal<string | null>(null);
  const [snapshot, setSnapshot] = createSignal<{ installationId: string; revision: number; prefix: string }>();
  const [invalid, setInvalid] = createSignal(true);
  const [finished, setFinished] = createSignal(false);
  const [uncertain, setUncertain] = createSignal(false);
  const [message, setMessage] = createSignal('');
  const [skipped, setSkipped] = createSignal<Array<{ key: string; reason: string }>>([]);
  const [operations, setOperations] = createSignal<string[]>([]);
  const [unconfirmed, setUnconfirmed] = createSignal<{ installationId: string; prefix: string;
    input: ApplicationRecoveryResetInput; confirmed: number; remaining: number }>();
  const validateResult = (input: ApplicationRecoveryResetInput, result: Awaited<ReturnType<typeof resetApplicationRecovery>>) => {
    const keys = new Set(input.entries.map(entry => entry.key));
    if (result.requestId !== input.requestId || result.reset + result.skipped.length !== input.entries.length
      || new Set(result.skipped.map(item => item.key)).size !== result.skipped.length
      || result.skipped.some(item => !keys.has(item.key))) throw new Error('Reset response could not be reconciled');
  };
  const checkResult = async () => {
    const attempt = unconfirmed();
    const sameContext = () => alive && attempt?.installationId === props.installationId
      && attempt.input.revision === props.revision && attempt.prefix === props.recovery.prefix;
    if (!attempt || pending() || props.blocked || !sameContext()) return;
    busy(true);
    try {
      const result = await resetApplicationRecovery(attempt.installationId, attempt.input);
      if (!sameContext()) return;
      validateResult(attempt.input, result);
      setSkipped(values => [...values, ...result.skipped]);
      setUnconfirmed(undefined); setUncertain(false); setInvalid(true); setFinished(true);
      setMessage(`${attempt.confirmed + result.reset} locks confirmed reset; ${skipped().length} skipped. ${attempt.remaining} not submitted. Refresh the preview and explicitly confirm before any further reset.`);
    } catch (error) {
      if (sameContext()) {
        if (error instanceof ApiError && error.status === 409) {
          setUnconfirmed(undefined); setUncertain(false); setInvalid(true);
          setMessage(`${attempt.confirmed} locks confirmed reset; ${skipped().length} skipped. This preview is stale. Refresh current installation state and preview again.`);
        } else setMessage(`${attempt.confirmed} locks confirmed reset; ${skipped().length} skipped. Reset outcome still unconfirmed; ${attempt.remaining} not submitted. Check this same reset result or inspect current locks.`);
      }
    } finally { if (alive) busy(false); }
  };
  const cursors = new Set<string>();
  let alive = true;
  let trigger: HTMLButtonElement | undefined;
  let heading: HTMLHeadingElement | undefined;
  onCleanup(() => { alive = false; if (pending()) props.onPending?.(false); });
  const busy = (value: boolean) => { setPending(value); props.onPending?.(value); };
  const current = () => snapshot()?.installationId === props.installationId
    && snapshot()?.revision === props.revision && snapshot()?.prefix === props.recovery.prefix;
  const eligible = () => items().filter(item => item.status === 'resettable');
  const preview = async (more = false) => {
    if (pending() || props.blocked || more && (!current() || invalid() || !next())) return;
    if (!more) {
      setSnapshot({ installationId: props.installationId, revision: props.revision, prefix: props.recovery.prefix });
      setItems([]); setNext(null); cursors.clear(); setInvalid(true);
      if (!uncertain()) { setFinished(false); setSkipped([]); setOperations([]); setUnconfirmed(undefined); }
    }
    const scope = snapshot()!;
    const after = more ? next()! : undefined;
    setOpen(true); busy(true);
    setMessage(uncertain() ? 'Inspecting current locks. The previous reset remains unconfirmed; no new reset is authorized.' : '');
    queueMicrotask(() => heading?.focus());
    try {
      const page = await previewApplicationRecovery(scope.installationId, { revision: scope.revision, ...(after ? { after } : {}) });
      if (!alive) return;
      if (!current()) throw new Error('Recovery scope changed');
      const existing = new Set(items().map(item => item.key));
      for (const item of page.items) {
        if (existing.has(item.key)) throw new Error('Repeated recovery row');
        existing.add(item.key);
      }
      if (page.nextCursor && (page.nextCursor === after || cursors.has(page.nextCursor))) throw new Error('Repeated recovery cursor');
      if (page.nextCursor) cursors.add(page.nextCursor);
      setItems(values => [...values, ...page.items]); setNext(page.nextCursor); setInvalid(false);
    } catch (error) {
      if (alive) {
        setInvalid(true);
        setMessage(error instanceof ApiError && error.status === 409
          ? 'This preview is stale. Refresh current installation state and preview again before resetting.'
          : 'Preview unavailable or incomplete. Refresh the preview before resetting.');
      }
    } finally { if (alive) busy(false); }
  };
  const confirm = async () => {
    if (pending() || props.blocked || invalid() || finished() || uncertain() || !current() || next() || !eligible().length) return;
    const scope = snapshot()!;
    const entries = eligible().map(({ key, version }) => ({ key, version }));
    busy(true); setFinished(true); setMessage('');
    let reset = 0;
    let submitted = 0;
    try {
      for (let offset = 0; offset < entries.length; offset += APPLICATION_RECOVERY_BATCH_SIZE) {
        if (!current()) throw new ApiError('Recovery scope changed', 409, 'Conflict');
        const chunk = entries.slice(offset, offset + APPLICATION_RECOVERY_BATCH_SIZE);
        const requestId = crypto.randomUUID();
        setOperations(values => [...values, requestId]);
        submitted = offset + chunk.length;
        const input = { revision: scope.revision, requestId, entries: chunk };
        setUnconfirmed({ installationId: scope.installationId, prefix: scope.prefix, input,
          confirmed: reset, remaining: entries.length - submitted });
        const result = await resetApplicationRecovery(scope.installationId, input);
        if (!alive) return;
        validateResult(input, result);
        setUnconfirmed(undefined);
        reset += result.reset;
        setSkipped(values => [...values, ...result.skipped]);
        setMessage(`${reset} locks reset; ${skipped().length} skipped. ${entries.length - submitted} not yet submitted.`);
      }
      setMessage(`${reset} locks reset; ${skipped().length} skipped. No run or settings change was requested.`);
    } catch (error) {
      if (alive) {
        setInvalid(true);
        if (error instanceof ApiError && error.status === 409) {
          setUnconfirmed(undefined);
          setMessage(`${reset} locks confirmed reset; ${skipped().length} skipped. This preview is stale. Remaining locks were not reset. Refresh current installation state and preview again.`);
        } else {
          setUncertain(true);
          setMessage(`${reset} locks confirmed reset; ${skipped().length} skipped. Reset outcome unconfirmed for the last batch; ${entries.length - submitted} not submitted. Inspect current locks before any further action. Do not start a new reset for the unconfirmed batch.`);
        }
      }
    } finally { if (alive) busy(false); }
  };
  const close = () => { if (!pending()) { setOpen(false); trigger?.focus(); } };
  return <section class="operator-scheduling" aria-label={props.recovery.label}>
    <button ref={trigger} type="button" class="admin-secondary-button" title={props.recovery.description}
      aria-describedby={`${id}-help`} aria-expanded={open()} aria-controls={id} disabled={pending() || props.blocked}
      onClick={() => { if (uncertain()) setOpen(true); else void preview(); }}>{props.recovery.label}</button>
    <span id={`${id}-help`} style={{ position: 'absolute', width: '1px', height: '1px', overflow: 'hidden',
      'clip-path': 'inset(50%)', 'white-space': 'nowrap' }}>{props.recovery.description}</span>
    <Show when={open()}><div id={id}>
      <h4 ref={heading} tabindex="-1">Recovery preview</h4>
      <p>{eligible().length} eligible locks{next() || invalid() ? ' in the loaded preview (incomplete)' : ''}.</p>
      <ul><For each={items()}>{item => <li>{item.label} — {item.status === 'blocked' ? `Blocked: ${item.reason}` : 'Eligible'}</li>}</For></ul>
      <Show when={!current()}><p role="alert">Installation changed. Refresh the preview before resetting.</p></Show>
      <Show when={pending()}><p role="status">{finished() ? 'Resetting reviewed locks…' : 'Loading recovery preview…'}</p></Show>
      <Show when={message()}><p role="status">{message()}</p></Show>
      <ul><For each={skipped()}>{item => <li>{item.key} — Skipped: {item.reason}</li>}</For></ul>
      <Show when={operations().length}><p>Reset request IDs: {operations().join(', ')}</p></Show>
      <div class="operator-actions">
        <Show when={uncertain() && unconfirmed()}><button type="button" class="admin-secondary-button"
          disabled={pending() || props.blocked || unconfirmed()?.installationId !== props.installationId
            || unconfirmed()?.input.revision !== props.revision || unconfirmed()?.prefix !== props.recovery.prefix}
          onClick={() => void checkResult()}>Check reset result</button></Show>
        <Show when={next()}><button type="button" class="admin-secondary-button" disabled={pending() || props.blocked || invalid() || !current()}
          onClick={() => void preview(true)}>Load more locks</button></Show>
        <button type="button" class="admin-secondary-button" disabled={pending() || props.blocked} onClick={() => void preview()}>
          {uncertain() ? 'Inspect current locks' : 'Refresh preview'}</button>
        <button type="button" class="admin-primary-button"
          disabled={pending() || props.blocked || invalid() || finished() || uncertain() || !current() || !!next() || !eligible().length}
          onClick={() => void confirm()}>Reset {eligible().length} locks</button>
        <button type="button" class="admin-secondary-button" disabled={pending()} onClick={close}>Cancel</button>
      </div>
    </div></Show>
  </section>;
};
export default OperatorRecovery;
