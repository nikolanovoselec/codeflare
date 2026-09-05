/* v8 ignore start -- user-validated administration UI */
import { For, Show, createMemo, createSignal, onMount, type Component } from 'solid-js';
import type { PiReasoningLevel, ReasoningScalar } from '../../types';

interface Props {
  existingRevisions: Array<Record<string, unknown>>;
  onSave: (revision: Record<string, unknown>) => void;
  onCancel: () => void;
}

type ScalarType = 'string' | 'number' | 'boolean' | 'null';
interface MappingRow {
  id: number;
  level: PiReasoningLevel;
  path: string;
  type: ScalarType;
  rawValue: string;
}
interface AliasRow {
  id: number;
  level: Exclude<PiReasoningLevel, 'off'>;
  target: Exclude<PiReasoningLevel, 'off'>;
}

const LEVELS: PiReasoningLevel[] = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const ENABLED_LEVELS = LEVELS.filter((level): level is Exclude<PiReasoningLevel, 'off'> => level !== 'off');
const RESPONSE_FIELDS = [
  'choices[].message.reasoning_content',
  'usage.completion_tokens_details.reasoning_tokens',
  'choices[].message.content',
  'choices[].message.tool_calls',
] as const;

function scalar(type: ScalarType, rawValue: string): ReasoningScalar {
  if (type === 'null') return null;
  if (type === 'boolean') return rawValue === 'true';
  if (type === 'number') return Number(rawValue);
  return rawValue;
}

const ReasoningProfileEditor: Component<Props> = (props) => {
  let nextId = 2;
  let heading!: HTMLHeadingElement;
  onMount(() => heading.focus());
  const [id, setId] = createSignal('');
  const [name, setName] = createSignal('');
  const [description, setDescription] = createSignal('');
  const [supported, setSupported] = createSignal<PiReasoningLevel[]>(['medium']);
  const [offSemantics, setOffSemantics] = createSignal<'unsupported' | 'explicit-disable'>('unsupported');
  const [mappings, setMappings] = createSignal<MappingRow[]>([
    { id: 1, level: 'medium', path: 'reasoning_effort', type: 'string', rawValue: 'medium' },
  ]);
  const [aliases, setAliases] = createSignal<AliasRow[]>([]);
  const [removePaths, setRemovePaths] = createSignal<string[]>(['reasoning_effort']);
  const [responseFields, setResponseFields] = createSignal<string[]>(['choices[].message.content', 'choices[].message.tool_calls']);
  const [limitations, setLimitations] = createSignal<string[]>(['']);
  const [provider, setProvider] = createSignal('');
  const [model, setModel] = createSignal('');
  const [route, setRoute] = createSignal('');
  const [observedAt, setObservedAt] = createSignal('');
  const [error, setError] = createSignal('');

  const toggleLevel = (level: PiReasoningLevel, enabled: boolean) => {
    if (level === 'off') {
      setOffSemantics(enabled ? 'explicit-disable' : 'unsupported');
      setSupported((levels) => enabled ? [...new Set<PiReasoningLevel>([...levels, 'off'])] : levels.filter((item) => item !== 'off'));
      if (enabled && !mappings().some((row) => row.level === 'off')) {
        setMappings((rows) => [...rows, { id: nextId++, level: 'off', path: 'reasoning_effort', type: 'string', rawValue: 'none' }]);
      }
      return;
    }
    setSupported((levels) => enabled ? [...new Set([...levels, level])] : levels.filter((item) => item !== level));
    if (!enabled) {
      setMappings((rows) => rows.filter((row) => row.level !== level));
      setAliases((rows) => rows.filter((row) => row.level !== level && row.target !== level));
    }
  };

  const setOff = (value: 'unsupported' | 'explicit-disable') => toggleLevel('off', value === 'explicit-disable');
  const updateMapping = (rowId: number, patch: Partial<MappingRow>) => setMappings((rows) => rows.map((row) => row.id === rowId ? { ...row, ...patch } : row));
  const updateAlias = (rowId: number, patch: Partial<AliasRow>) => setAliases((rows) => rows.map((row) => row.id === rowId ? { ...row, ...patch } : row));
  const updateString = (values: string[], index: number, value: string): string[] => values.map((item, itemIndex) => itemIndex === index ? value : item);

  const revision = createMemo(() => {
    const matching = props.existingRevisions.filter((item) => item.id === id());
    return Math.max(0, ...matching.map((item) => typeof item.revision === 'number' ? item.revision : 0)) + 1;
  });

  const normalized = createMemo<Record<string, unknown>>(() => {
    const ownLevels = Object.fromEntries(supported().flatMap((level) => {
      const writes = mappings().filter((row) => row.level === level && row.path.trim()).map((row) => ({
        path: row.path.trim(),
        value: scalar(row.type, row.rawValue),
      }));
      return writes.length > 0 ? [[level, writes]] : [];
    }));
    const aliasMap = Object.fromEntries(aliases().filter((alias) => supported().includes(alias.level)).map((alias) => [alias.level, alias.target]));
    const recognizedResponseFields = {
      reasoning: responseFields().filter((field) => field.includes('reasoning')),
      content: responseFields().filter((field) => field.endsWith('.content')),
      tools: responseFields().filter((field) => field.endsWith('.tool_calls')),
    };
    const offWrite = mappings().find((row) => row.level === 'off' && row.path.trim());
    return {
      id: id().trim(),
      name: name().trim(),
      description: description().trim(),
      schemaVersion: 1,
      revision: revision(),
      enabled: true,
      ingressContract: 'ai-gateway-chat-completions',
      supportedLevels: LEVELS.filter((level) => supported().includes(level)),
      removePaths: removePaths().map((path) => path.trim()).filter(Boolean),
      levels: ownLevels,
      aliases: aliasMap,
      offSemantics: offSemantics() === 'explicit-disable' && offWrite
        ? { status: offWrite.path.trim().endsWith('enable_thinking') ? 'explicit-toggle' : 'explicit-value', path: offWrite.path.trim(), value: scalar(offWrite.type, offWrite.rawValue) }
        : { status: 'unsupported' },
      recognizedResponseFields,
      limitations: limitations().map((item) => item.trim()).filter(Boolean),
      originallyCreatedAgainst: {
        ...(provider().trim() && { provider: provider().trim() }),
        ...(model().trim() && { modelId: model().trim() }),
        ...(route().trim() && { route: route().trim() }),
        ...(observedAt() && { observedAt: observedAt() }),
      },
      evidence: [{
        evidenceType: 'administrator-declared-provenance',
        ...(provider().trim() && { provider: provider().trim() }),
        ...(model().trim() && { modelId: model().trim() }),
        ...(route().trim() && { route: route().trim() }),
        ...(observedAt() && { observedAt: observedAt() }),
      }],
    };
  });

  const save = () => {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id().trim())) {
      setError('Profile ID must use 1–64 lowercase letters, numbers, or hyphens.');
      return;
    }
    if (!name().trim()) {
      setError('Profile name is required.');
      return;
    }
    if (supported().length === 0) {
      setError('Select at least one supported reasoning level.');
      return;
    }
    const levels = normalized().levels as Record<string, unknown[]>;
    const aliasMap = normalized().aliases as Record<string, string>;
    const missing = supported().find((level) => !levels[level]?.length && !aliasMap[level]);
    if (missing) {
      setError(`Add an own mapping or alias for ${missing}.`);
      return;
    }
    if (mappings().some((row) => row.type === 'number' && !Number.isFinite(Number(row.rawValue)))) {
      setError('Mapping numbers must be finite.');
      return;
    }
    setError('');
    props.onSave(normalized());
  };

  return <section class="admin-profile-editor admin-form-wide" aria-labelledby="custom-profile-heading">
    <div class="admin-subsection-heading">
      <div><h3 id="custom-profile-heading" tabIndex={-1} ref={heading}>Create custom capability profile</h3><p>Build one bounded, immutable revision through typed Chat Completions controls.</p></div>
      <button type="button" class="admin-secondary-button" onClick={props.onCancel}>Close editor</button>
    </div>
    <Show when={error()}><div class="admin-inline-error" role="alert">{error()}</div></Show>
    <div class="admin-profile-grid">
      <label class="admin-form-field"><span>Profile ID</span><input value={id()} maxlength="64" onInput={(event) => setId(event.currentTarget.value)} /></label>
      <label class="admin-form-field"><span>Profile name</span><input value={name()} maxlength="128" onInput={(event) => setName(event.currentTarget.value)} /></label>
      <label class="admin-form-field admin-form-wide"><span>Description</span><input value={description()} maxlength="512" onInput={(event) => setDescription(event.currentTarget.value)} /></label>
      <div class="admin-readonly-field"><span>Ingress contract</span><strong>AI Gateway Chat Completions</strong><small>Transport, credentials, model, messages, tools, and stream controls are protected.</small></div>
      <div class="admin-readonly-field"><span>Revision ownership</span><strong>Immutable revision {revision()}</strong><small>Saving this draft never changes revisions already assigned to routes.</small></div>
    </div>

    <fieldset class="admin-fieldset" aria-label="Supported reasoning levels">
      <legend>Supported reasoning levels</legend>
      <div class="admin-checkbox-list"><For each={LEVELS}>{(level) => <label class="admin-toggle-field"><input type="checkbox" checked={supported().includes(level)} onChange={(event) => toggleLevel(level, event.currentTarget.checked)} /><span>{level}</span></label>}</For></div>
    </fieldset>

    <label class="admin-form-field admin-profile-narrow"><span>Off semantics</span><select aria-label="Off semantics" value={offSemantics()} onChange={(event) => setOff(event.currentTarget.value as 'unsupported' | 'explicit-disable')}><option value="unsupported">Unsupported</option><option value="explicit-disable">Explicit disable mapping</option></select></label>

    <section class="admin-profile-section" aria-labelledby="mapping-heading">
      <div class="admin-subsection-heading"><div><h4 id="mapping-heading">Scalar mappings</h4><p>Each row writes one literal scalar to a bounded request path.</p></div><button type="button" class="admin-secondary-button" onClick={() => setMappings((rows) => [...rows, { id: nextId++, level: supported().find((level) => level !== 'off') ?? 'medium', path: '', type: 'string', rawValue: '' }])}>Add mapping row</button></div>
      <div class="admin-mapping-list"><For each={mappings()}>{(row, index) => <div class="admin-mapping-row">
        <label class="admin-form-field"><span>Reasoning level</span><select aria-label={index() === 0 ? 'Mapping reasoning level' : `Mapping ${index() + 1} reasoning level`} value={row.level} onChange={(event) => updateMapping(row.id, { level: event.currentTarget.value as PiReasoningLevel })}><For each={supported()}>{(level) => <option value={level}>{level}</option>}</For></select></label>
        <label class="admin-form-field"><span>Property path</span><input aria-label={index() === 0 ? 'Mapping property path' : `Mapping ${index() + 1} property path`} value={row.path} maxlength="128" onInput={(event) => updateMapping(row.id, { path: event.currentTarget.value })} /></label>
        <label class="admin-form-field"><span>Value type</span><select aria-label={index() === 0 ? 'Mapping value type' : `Mapping ${index() + 1} value type`} value={row.type} onChange={(event) => updateMapping(row.id, { type: event.currentTarget.value as ScalarType })}><For each={['string', 'number', 'boolean', 'null'] as ScalarType[]}>{(type) => <option value={type}>{type}</option>}</For></select></label>
        <Show when={row.type === 'boolean'} fallback={<Show when={row.type !== 'null'}><label class="admin-form-field"><span>Value</span><input aria-label={index() === 0 ? 'Mapping value' : `Mapping ${index() + 1} value`} type={row.type === 'number' ? 'number' : 'text'} value={row.rawValue} onInput={(event) => updateMapping(row.id, { rawValue: event.currentTarget.value })} /></label></Show>}><label class="admin-form-field"><span>Value</span><select aria-label={index() === 0 ? 'Mapping boolean value' : `Mapping ${index() + 1} boolean value`} value={row.rawValue} onChange={(event) => updateMapping(row.id, { rawValue: event.currentTarget.value })}><option value="false">false</option><option value="true">true</option></select></label></Show>
        <button type="button" class="admin-link-button" aria-label={`Remove ${row.level} mapping row`} onClick={() => setMappings((rows) => rows.filter((item) => item.id !== row.id))}>Remove</button>
      </div>}</For></div>
    </section>

    <section class="admin-profile-section" aria-labelledby="alias-heading">
      <div class="admin-subsection-heading"><div><h4 id="alias-heading">Aliases</h4><p>Aliases reuse the target level’s exact serialized mapping bytes. Off cannot alias an enabled level.</p></div><button type="button" class="admin-secondary-button" onClick={() => { const level = ENABLED_LEVELS.find((item) => !supported().includes(item)) ?? 'high'; setSupported((levels) => [...new Set([...levels, level])]); setAliases((rows) => [...rows, { id: nextId++, level, target: supported().find((item): item is Exclude<PiReasoningLevel, 'off'> => item !== 'off') ?? 'medium' }]); }}>Alias reasoning level</button></div>
      <For each={aliases()}>{(alias) => <div class="admin-alias-row"><label class="admin-form-field"><span>Alias level</span><select aria-label="Alias level" value={alias.level} onChange={(event) => updateAlias(alias.id, { level: event.currentTarget.value as AliasRow['level'] })}><For each={ENABLED_LEVELS}>{(level) => <option value={level}>{level}</option>}</For></select></label><span aria-hidden="true">uses</span><label class="admin-form-field"><span>Alias target</span><select aria-label="Alias target" value={alias.target} onChange={(event) => updateAlias(alias.id, { target: event.currentTarget.value as AliasRow['target'] })}><For each={ENABLED_LEVELS.filter((level) => supported().includes(level) && level !== alias.level)}>{(level) => <option value={level}>{level}</option>}</For></select></label><button type="button" class="admin-link-button" onClick={() => setAliases((rows) => rows.filter((item) => item.id !== alias.id))}>Remove alias</button></div>}</For>
    </section>

    <section class="admin-profile-section" aria-labelledby="removal-heading"><div class="admin-subsection-heading"><div><h4 id="removal-heading">Conflicting paths to remove</h4><p>Only bounded reasoning fields may be removed.</p></div><button type="button" class="admin-secondary-button" onClick={() => setRemovePaths((paths) => [...paths, ''])}>Add removal path</button></div><div class="admin-simple-list"><For each={removePaths()}>{(path, index) => <label class="admin-form-field"><span>Removal path {index() + 1}</span><input value={path} maxlength="128" onInput={(event) => setRemovePaths((paths) => updateString(paths, index(), event.currentTarget.value))} /></label>}</For></div></section>

    <fieldset class="admin-fieldset"><legend>Recognized response fields</legend><div class="admin-checkbox-list"><For each={RESPONSE_FIELDS}>{(field) => <label class="admin-toggle-field"><input type="checkbox" checked={responseFields().includes(field)} onChange={(event) => setResponseFields((fields) => event.currentTarget.checked ? [...new Set([...fields, field])] : fields.filter((item) => item !== field))} /><span class="admin-mono">{field}</span></label>}</For></div></fieldset>

    <section class="admin-profile-section" aria-labelledby="limitations-heading"><div class="admin-subsection-heading"><div><h4 id="limitations-heading">Limitations</h4><p>Operator notes cannot assert verification or remove system-derived limitations.</p></div><button type="button" class="admin-secondary-button" onClick={() => setLimitations((items) => [...items, ''])}>Add limitation</button></div><div class="admin-simple-list"><For each={limitations()}>{(limitation, index) => <label class="admin-form-field"><span>Limitation {index() + 1}</span><input value={limitation} maxlength="512" onInput={(event) => setLimitations((items) => updateString(items, index(), event.currentTarget.value))} /></label>}</For></div></section>

    <fieldset class="admin-fieldset"><legend>Immutable provenance</legend><div class="admin-profile-grid"><label class="admin-form-field"><span>Provider</span><input aria-label="Provenance provider" value={provider()} onInput={(event) => setProvider(event.currentTarget.value)} /></label><label class="admin-form-field"><span>Observed model</span><input value={model()} onInput={(event) => setModel(event.currentTarget.value)} /></label><label class="admin-form-field"><span>Evidence route</span><input value={route()} onInput={(event) => setRoute(event.currentTarget.value)} /></label><label class="admin-form-field"><span>Observed date</span><input type="date" value={observedAt()} onInput={(event) => setObservedAt(event.currentTarget.value)} /></label></div></fieldset>

    <label class="admin-form-field admin-form-wide"><span>Normalized wire preview</span><textarea aria-label="Normalized wire preview" rows="14" readOnly value={JSON.stringify(normalized(), null, 2)} /></label>
    <div class="admin-profile-actions"><button type="button" class="admin-secondary-button" onClick={props.onCancel}>Cancel</button><button type="button" class="admin-primary-button" onClick={save}>Add immutable revision to draft</button></div>
  </section>;
};

export default ReasoningProfileEditor;
/* v8 ignore stop */
