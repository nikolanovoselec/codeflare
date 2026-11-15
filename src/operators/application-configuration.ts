import type { OperatorApplicationDefinition } from './distribution';

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Read declared configuration without evaluating application code or mutating saved data. */
export function applicationSetting(
  definition: OperatorApplicationDefinition, configuration: unknown, pointer: string,
): unknown {
  let value = configuration;
  let schema: unknown = definition.configurationSchema;
  for (const encoded of pointer.slice(1).split('/')) {
    const key = encoded.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!key || ['__proto__', 'constructor', 'prototype'].includes(key)) return undefined;
    value = record(value) && Object.hasOwn(value, key) ? value[key] : undefined;
    const properties = record(schema) && record(schema.properties) ? schema.properties : undefined;
    schema = properties && Object.hasOwn(properties, key) ? properties[key] : undefined;
  }
  return value === undefined && record(schema) && Object.hasOwn(schema, 'default') ? schema.default : value;
}

/** A schedule is declared by the package; absence or invalid data never arms one. */
export function applicationSchedule(definition: OperatorApplicationDefinition | undefined, configuration: unknown):
  { automaticRuns: boolean; repetitionIntervalSeconds: number } | null {
  if (!definition?.schedule) return null;
  const automaticRuns = applicationSetting(definition, configuration, definition.schedule.enabledPath);
  const interval = applicationSetting(definition, configuration, definition.schedule.intervalSecondsPath);
  if (typeof automaticRuns !== 'boolean' || typeof interval !== 'number' || !Number.isSafeInteger(interval)
    || interval <= 0 || !Number.isFinite(new Date(Date.now() + interval * 1000).getTime())) return null;
  return { automaticRuns, repetitionIntervalSeconds: interval };
}

/** Package-declared resource selector, resolved only from the owner-saved configuration. */
export function applicationWriteRepositories(definition: OperatorApplicationDefinition | undefined, configuration: unknown): string[] {
  if (!definition?.githubWriteRepositoriesPath) return [];
  const selected = applicationSetting(definition, configuration, definition.githubWriteRepositoriesPath);
  const repositories = typeof selected === 'string' ? [selected] : selected;
  if (!Array.isArray(repositories) || !repositories.length || repositories.length > 128
    || !repositories.every(value => typeof value === 'string' && value.length <= 201
      && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)
      && value.split('/').every(part => part !== '.' && part !== '..'))) return [];
  return [...new Set(repositories.map(value => value.toLowerCase()))];
}
