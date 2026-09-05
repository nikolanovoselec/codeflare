import {
  BUILT_IN_REASONING_PROFILES,
  canonicalHash,
  canonicalJson,
  getBuiltInProfile,
  getBuiltInProfileRef,
  isPiReasoningLevel,
  normalizeCustomProfile,
  validateRequestPath,
  type NormalizedLevelMapping,
  type NormalizedReasoningProfile,
  type PiReasoningLevel,
  type ProfileRevisionRef,
  type ScalarValue,
  type ScalarWrite,
} from './reasoning-profiles';

export const MAX_REASONING_CONFIGURATION_BYTES = 256 * 1024;
export const MAX_CUSTOM_PROFILE_IDS = 32;
export const MAX_CUSTOM_PROFILE_REVISIONS = 64;
const HASH_PATTERN = /^[0-9a-f]{64}$/;
const MAX_ROUTE_NAME = 256;
const MAX_REFERENCE_TEXT = 256;
const MAX_MAPPING_ENTRIES = 16;

export interface EvidenceRef extends Record<string, ScalarValue | ScalarValue[]> {}

export interface RouteLegAssignment {
  nodeId: string;
  provider: string;
  declaredModel: string;
  customProviderBackend?: string;
  profileRef: ProfileRevisionRef;
  evidence?: EvidenceRef;
}

export interface RouteReasoningAssignment {
  activeProfile: ProfileRevisionRef;
  routeVersion?: string;
  legs?: RouteLegAssignment[];
  commonMapping?: {
    levels: Partial<Record<PiReasoningLevel, NormalizedLevelMapping>>;
    digest: string;
  };
  migration?: { sourceProfileId: string };
}

export interface ReasoningConfiguration {
  schemaVersion: 1;
  customProfileRevisions: NormalizedReasoningProfile[];
  routeAssignments: Record<string, RouteReasoningAssignment>;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function assertOnly(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  const unknown = Object.keys(record).find((key) => !keys.includes(key));
  if (unknown) throw new Error(`${label} has unknown field ${unknown}`);
}

function bounded(value: unknown, label: string, max = MAX_REFERENCE_TEXT): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max || /[\r\n\0]/.test(value)) throw new Error(`${label} is invalid`);
  return value;
}

function routeName(value: string): string {
  bounded(value, 'route name', MAX_ROUTE_NAME);
  if (value.includes('/') || ['__proto__', 'prototype', 'constructor'].includes(value.toLowerCase())) throw new Error('route name must be a safe slash-free handle');
  return value;
}

function scalar(value: unknown, label: string, maxString = 512): ScalarValue {
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length <= maxString) return value;
  throw new Error(`${label} must be a sanitized scalar`);
}

function parseEvidence(value: unknown, label: string): EvidenceRef {
  const record = asRecord(value, label);
  if (Object.keys(record).length > 20) throw new Error(`${label} has too many summaries`);
  const result: EvidenceRef = {};
  for (const [key, child] of Object.entries(record)) {
    if (!/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)) throw new Error(`${label} has an invalid key`);
    if (Array.isArray(child)) {
      if (child.length > 20) throw new Error(`${label}.${key} has too many summaries`);
      result[key] = child.map((item) => scalar(item, `${label}.${key}`));
    } else result[key] = scalar(child, `${label}.${key}`);
  }
  return result;
}

function parseRef(value: unknown, label: string): ProfileRevisionRef {
  const record = asRecord(value, label);
  assertOnly(record, ['id', 'revision', 'hash'], label);
  const id = bounded(record.id, `${label}.id`, 64);
  if (!Number.isInteger(record.revision) || (record.revision as number) < 1) throw new Error(`${label}.revision is invalid`);
  if (typeof record.hash !== 'string' || !HASH_PATTERN.test(record.hash)) throw new Error(`${label}.hash is invalid`);
  return { id, revision: record.revision as number, hash: record.hash };
}

function parseWrites(value: unknown, label: string): ScalarWrite[] {
  if (!Array.isArray(value) || value.length > MAX_MAPPING_ENTRIES) throw new Error(`${label} has too many writes`);
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const record = asRecord(entry, `${label}[${index}]`);
    assertOnly(record, ['path', 'value'], `${label}[${index}]`);
    const path = validateRequestPath(record.path);
    if (seen.has(path)) throw new Error(`${label} has a duplicate path`);
    seen.add(path);
    return { path, value: scalar(record.value, `${label}[${index}].value`, 256) };
  });
}

function parseMapping(value: unknown, label: string): NormalizedLevelMapping {
  const record = asRecord(value, label);
  assertOnly(record, ['removePaths', 'writes'], label);
  if (!Array.isArray(record.removePaths) || record.removePaths.length > MAX_MAPPING_ENTRIES) throw new Error(`${label}.removePaths is invalid`);
  const removePaths = record.removePaths.map(validateRequestPath);
  if (new Set(removePaths).size !== removePaths.length) throw new Error(`${label}.removePaths must be unique`);
  return { removePaths, writes: parseWrites(record.writes, `${label}.writes`) };
}

function resolveRef(ref: ProfileRevisionRef, customs: Map<string, NormalizedReasoningProfile>, label: string): NormalizedReasoningProfile {
  const builtIn = getBuiltInProfile(ref.id);
  const profile = builtIn ?? customs.get(`${ref.id}:${ref.revision}`);
  if (!profile || profile.revision !== ref.revision || profile.hash !== ref.hash) throw new Error(`${label} references a missing or non-canonical profile revision`);
  if (!profile.enabled) throw new Error(`${label} references a disabled profile revision`);
  return profile;
}

function parseAssignment(value: unknown, customs: Map<string, NormalizedReasoningProfile>, label: string): RouteReasoningAssignment {
  const record = asRecord(value, label);
  assertOnly(record, ['activeProfile', 'routeVersion', 'legs', 'commonMapping', 'migration'], label);
  const activeProfile = parseRef(record.activeProfile, `${label}.activeProfile`);
  resolveRef(activeProfile, customs, `${label}.activeProfile`);
  const result: RouteReasoningAssignment = { activeProfile };
  if (record.routeVersion !== undefined) result.routeVersion = bounded(record.routeVersion, `${label}.routeVersion`);
  if (record.legs !== undefined) {
    if (!Array.isArray(record.legs)) throw new Error(`${label}.legs must be an array`);
    const nodeIds = new Set<string>();
    result.legs = record.legs.map((entry, index) => {
      const leg = asRecord(entry, `${label}.legs[${index}]`);
      assertOnly(leg, ['nodeId', 'provider', 'declaredModel', 'customProviderBackend', 'profileRef', 'evidence'], `${label}.legs[${index}]`);
      const nodeId = bounded(leg.nodeId, `${label}.legs[${index}].nodeId`);
      if (nodeIds.has(nodeId)) throw new Error(`${label}.legs has duplicate nodeId ${nodeId}`);
      nodeIds.add(nodeId);
      const profileRef = parseRef(leg.profileRef, `${label}.legs[${index}].profileRef`);
      resolveRef(profileRef, customs, `${label}.legs[${index}].profileRef`);
      const provider = bounded(leg.provider, `${label}.legs[${index}].provider`);
      if (provider.toLowerCase().startsWith('custom') && leg.customProviderBackend === undefined) {
        throw new Error(`${label}.legs[${index}] requires administrator-declared custom provider backend provenance`);
      }
      return {
        nodeId,
        provider,
        declaredModel: bounded(leg.declaredModel, `${label}.legs[${index}].declaredModel`),
        ...(leg.customProviderBackend !== undefined && { customProviderBackend: bounded(leg.customProviderBackend, `${label}.legs[${index}].customProviderBackend`) }),
        profileRef,
        ...(leg.evidence !== undefined && { evidence: parseEvidence(leg.evidence, `${label}.legs[${index}].evidence`) }),
      };
    });
  }
  if (record.commonMapping !== undefined) {
    const common = asRecord(record.commonMapping, `${label}.commonMapping`);
    assertOnly(common, ['levels', 'digest'], `${label}.commonMapping`);
    const rawLevels = asRecord(common.levels, `${label}.commonMapping.levels`);
    const levels: Partial<Record<PiReasoningLevel, NormalizedLevelMapping>> = {};
    for (const [level, mapping] of Object.entries(rawLevels)) {
      if (!isPiReasoningLevel(level)) throw new Error(`${label}.commonMapping has an unsupported level`);
      levels[level] = parseMapping(mapping, `${label}.commonMapping.levels.${level}`);
    }
    if (typeof common.digest !== 'string' || common.digest !== canonicalHash(levels)) throw new Error(`${label}.commonMapping digest is not canonical`);
    result.commonMapping = { levels, digest: common.digest };
  }
  if (record.migration !== undefined) {
    const migration = asRecord(record.migration, `${label}.migration`);
    assertOnly(migration, ['sourceProfileId'], `${label}.migration`);
    result.migration = { sourceProfileId: bounded(migration.sourceProfileId, `${label}.migration.sourceProfileId`, 64) };
  }
  return result;
}

function byteLength(value: unknown): number {
  let serialized: string;
  try { serialized = JSON.stringify(value); } catch { throw new Error('reasoning configuration is not serializable'); }
  if (serialized === undefined) throw new Error('reasoning configuration is not serializable');
  return new TextEncoder().encode(serialized).byteLength;
}

export function parseReasoningConfiguration(input: unknown): ReasoningConfiguration {
  const parsedInput = typeof input === 'string' ? (() => {
    try { return JSON.parse(input) as unknown; } catch { throw new Error('reasoning configuration is invalid JSON'); }
  })() : input;
  if (byteLength(parsedInput) > MAX_REASONING_CONFIGURATION_BYTES) throw new Error('reasoning configuration exceeds the 256 KiB size limit');
  const record = asRecord(parsedInput, 'reasoning configuration');
  assertOnly(record, ['schemaVersion', 'customProfileRevisions', 'routeAssignments'], 'reasoning configuration');
  if (record.schemaVersion !== 1) throw new Error('reasoning configuration schemaVersion must be 1');
  if (!Array.isArray(record.customProfileRevisions) || record.customProfileRevisions.length > MAX_CUSTOM_PROFILE_REVISIONS) {
    throw new Error(`reasoning configuration supports at most ${MAX_CUSTOM_PROFILE_REVISIONS} custom revisions`);
  }
  const customProfileRevisions = record.customProfileRevisions.map(normalizeCustomProfile);
  if (new Set(customProfileRevisions.map((profile) => profile.id)).size > MAX_CUSTOM_PROFILE_IDS) {
    throw new Error(`reasoning configuration supports at most ${MAX_CUSTOM_PROFILE_IDS} custom profile IDs`);
  }
  const customKeys = new Set<string>();
  const customMap = new Map<string, NormalizedReasoningProfile>();
  for (const profile of customProfileRevisions) {
    const key = `${profile.id}:${profile.revision}`;
    if (customKeys.has(key)) throw new Error(`duplicate custom profile revision ${key}`);
    customKeys.add(key);
    customMap.set(key, profile);
  }
  const rawAssignments = asRecord(record.routeAssignments, 'routeAssignments');
  const routeAssignments: Record<string, RouteReasoningAssignment> = {};
  for (const [route, assignment] of Object.entries(rawAssignments)) {
    routeAssignments[routeName(route)] = parseAssignment(assignment, customMap, `routeAssignments.${route}`);
  }
  const result: ReasoningConfiguration = { schemaVersion: 1, customProfileRevisions, routeAssignments };
  if (byteLength(result) > MAX_REASONING_CONFIGURATION_BYTES) throw new Error('reasoning configuration exceeds the 256 KiB size limit');
  return result;
}

export function serializeReasoningConfiguration(input: unknown): string {
  const parsed = parseReasoningConfiguration(input);
  const serialized = canonicalJson(parsed);
  if (new TextEncoder().encode(serialized).byteLength > MAX_REASONING_CONFIGURATION_BYTES) throw new Error('reasoning configuration exceeds the 256 KiB size limit');
  return serialized;
}

export function getProfileForRef(configuration: ReasoningConfiguration, ref: ProfileRevisionRef): NormalizedReasoningProfile {
  const customMap = new Map(configuration.customProfileRevisions.map((profile) => [`${profile.id}:${profile.revision}`, profile]));
  return resolveRef(ref, customMap, 'profile reference');
}

export function getRouteReasoningProfile(configuration: ReasoningConfiguration, route: string): NormalizedReasoningProfile {
  const assignment = configuration.routeAssignments[route];
  if (!assignment) throw new Error(`reasoning profile required for route ${route}`);
  return getProfileForRef(configuration, assignment.activeProfile);
}

function referencedKeys(configuration: ReasoningConfiguration): Set<string> {
  const refs = new Set<string>();
  for (const assignment of Object.values(configuration.routeAssignments)) {
    refs.add(`${assignment.activeProfile.id}:${assignment.activeProfile.revision}`);
    for (const leg of assignment.legs ?? []) refs.add(`${leg.profileRef.id}:${leg.profileRef.revision}`);
  }
  return refs;
}

export function validateReasoningConfigurationUpdate(currentInput: unknown, proposedInput: unknown): ReasoningConfiguration {
  const currentRecord = asRecord(currentInput, 'current reasoning configuration');
  const proposedRecord = asRecord(proposedInput, 'proposed reasoning configuration');
  const currentRawProfiles = Array.isArray(currentRecord.customProfileRevisions) ? currentRecord.customProfileRevisions : [];
  const proposedRawProfiles = Array.isArray(proposedRecord.customProfileRevisions) ? proposedRecord.customProfileRevisions : [];
  const proposedRawKeys = new Set(proposedRawProfiles.flatMap((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    return typeof record.id === 'string' && Number.isInteger(record.revision) ? [`${record.id}:${record.revision}`] : [];
  }));
  const collectRawRefs = (assignmentsValue: unknown, label: string): Set<string> => {
    const assignments = asRecord(assignmentsValue ?? {}, label);
    const refs = new Set<string>();
    for (const assignmentValue of Object.values(assignments)) {
      if (!assignmentValue || typeof assignmentValue !== 'object' || Array.isArray(assignmentValue)) continue;
      const assignment = assignmentValue as Record<string, unknown>;
      for (const refValue of [assignment.activeProfile, ...(Array.isArray(assignment.legs) ? assignment.legs.map((leg) => (leg as Record<string, unknown>)?.profileRef) : [])]) {
        if (refValue && typeof refValue === 'object' && !Array.isArray(refValue)) {
          const ref = refValue as Record<string, unknown>;
          if (typeof ref.id === 'string' && Number.isInteger(ref.revision)) refs.add(`${ref.id}:${ref.revision}`);
        }
      }
    }
    return refs;
  };
  const rawRefs = collectRawRefs(proposedRecord.routeAssignments, 'proposed routeAssignments');
  const currentRawRefs = collectRawRefs(currentRecord.routeAssignments, 'current routeAssignments');
  for (const raw of currentRawProfiles) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const profile = raw as Record<string, unknown>;
    const key = `${profile.id}:${profile.revision}`;
    if ((currentRawRefs.has(key) || rawRefs.has(key)) && !proposedRawKeys.has(key)) {
      throw new Error(`custom profile revision ${key} is referenced and cannot be collected`);
    }
  }
  for (const raw of proposedRawProfiles) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    const profile = raw as Record<string, unknown>;
    const key = `${profile.id}:${profile.revision}`;
    if (profile.enabled === false && rawRefs.has(key)) throw new Error(`custom profile revision ${key} is referenced and cannot be disabled`);
  }

  const current = parseReasoningConfiguration(currentInput);
  const proposed = parseReasoningConfiguration(proposedInput);
  const currentByKey = new Map(current.customProfileRevisions.map((profile) => [`${profile.id}:${profile.revision}`, profile]));
  for (const profile of proposed.customProfileRevisions) {
    const prior = currentByKey.get(`${profile.id}:${profile.revision}`);
    if (prior && prior.hash !== profile.hash) throw new Error(`custom profile revision ${profile.id}:${profile.revision} is immutable`);
  }
  const refs = referencedKeys(proposed);
  for (const profile of proposed.customProfileRevisions) {
    if (!profile.enabled && refs.has(`${profile.id}:${profile.revision}`)) throw new Error(`custom profile revision ${profile.id}:${profile.revision} is referenced and cannot be disabled`);
  }
  return proposed;
}

interface LegacyDefaultSelection {
  route?: unknown;
  defaultRoute?: unknown;
  reasoning?: unknown;
}

export interface LegacyMigrationInput {
  routeSettings: unknown;
  defaults?: {
    global?: LegacyDefaultSelection | null;
    groups?: Record<string, LegacyDefaultSelection>;
  };
}

export interface LegacyMigrationResult {
  proposed: ReasoningConfiguration;
  errors: Array<{ code: string; route?: string; scope?: string; message: string }>;
  persisted: false;
}

const LEGACY_PROFILE_MAPPINGS = {
  'workers-ai-glm-5.3': 'workers-ai-glm-thinking',
  'workers-ai-kimi-k2.6': 'workers-ai-kimi-k-thinking',
} as const;

export function migrateLegacyReasoningAssignments(input: LegacyMigrationInput): LegacyMigrationResult {
  const routeAssignments: Record<string, RouteReasoningAssignment> = {};
  const errors: LegacyMigrationResult['errors'] = [];
  let settings: Record<string, unknown>;
  try {
    settings = asRecord(input.routeSettings ?? {}, 'legacy route settings');
  } catch {
    return {
      proposed: { schemaVersion: 1, customProfileRevisions: [], routeAssignments },
      errors: [{ code: 'legacy_configuration_malformed', message: 'Legacy reasoning configuration is malformed and requires administrator correction' }],
      persisted: false,
    };
  }
  for (const [route, raw] of Object.entries(settings)) {
    try {
      routeName(route);
    } catch {
      errors.push({ code: 'legacy_assignment_malformed', message: 'A legacy route assignment has an invalid route handle' });
      continue;
    }
    if (typeof raw === 'number') {
      errors.push({ code: 'legacy_assignment_missing', route, message: `Route ${route} has no legacy reasoning profile assignment` });
      continue;
    }
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push({ code: 'legacy_assignment_malformed', route, message: `Route ${route} has a malformed legacy reasoning assignment` });
      continue;
    }
    const legacy = (raw as Record<string, unknown>).reasoningProfile;
    if (legacy === undefined) {
      errors.push({ code: 'legacy_assignment_missing', route, message: `Route ${route} requires an explicit profile assignment` });
      continue;
    }
    if (typeof legacy !== 'string') {
      errors.push({ code: 'legacy_assignment_malformed', route, message: `Route ${route} has a malformed legacy reasoning profile` });
      continue;
    }
    if (legacy === 'workers-ai-gpt-oss') {
      errors.push({ code: 'legacy_profile_unresolved', route, message: 'GPT-OSS tool replay is unsupported; select another profile' });
      continue;
    }
    const mapped = LEGACY_PROFILE_MAPPINGS[legacy as keyof typeof LEGACY_PROFILE_MAPPINGS];
    if (!mapped) {
      errors.push({ code: 'legacy_assignment_missing', route, message: `Route ${route} requires an explicit profile assignment` });
      continue;
    }
    routeAssignments[route] = {
      activeProfile: getBuiltInProfileRef(mapped),
      migration: { sourceProfileId: legacy },
    };
  }
  const proposed: ReasoningConfiguration = { schemaVersion: 1, customProfileRevisions: [], routeAssignments };
  const defaults = [
    { scope: 'global', value: input.defaults?.global },
    ...Object.entries(input.defaults?.groups ?? {}).map(([scope, value]) => ({ scope, value })),
  ];
  for (const { scope, value } of defaults) {
    if (!value) continue;
    const route = typeof value.route === 'string' ? value.route : typeof value.defaultRoute === 'string' ? value.defaultRoute : undefined;
    if (!route || !isPiReasoningLevel(value.reasoning)) continue;
    const assignment = proposed.routeAssignments[route];
    if (!assignment) continue;
    const profile = getBuiltInProfile(assignment.activeProfile.id)!;
    if (!profile.supportedLevels.includes(value.reasoning)) {
      errors.push({ code: 'default_level_unmapped', route, scope, message: `${scope} default ${value.reasoning} is not mapped by ${profile.id}` });
    }
  }
  return { proposed, errors, persisted: false };
}

/**
 * Parse the atomic document when present, otherwise derive an in-memory view of
 * the historical combined route settings. The fallback is intentionally strict:
 * any unresolved, malformed, or ambiguous legacy entry rejects the whole view,
 * and no KV write is performed.
 */
export function parseReasoningConfigurationWithLegacyFallback(
  configurationInput: unknown,
  legacyRouteSettingsInput: unknown,
  defaults?: LegacyMigrationInput['defaults'],
): ReasoningConfiguration {
  if (configurationInput !== undefined && configurationInput !== null) {
    return parseReasoningConfiguration(configurationInput);
  }

  let routeSettings = legacyRouteSettingsInput;
  if (typeof legacyRouteSettingsInput === 'string') {
    try {
      routeSettings = JSON.parse(legacyRouteSettingsInput) as unknown;
    } catch {
      routeSettings = legacyRouteSettingsInput;
    }
  }
  const migration = migrateLegacyReasoningAssignments({ routeSettings, defaults });
  if (migration.errors.length > 0) {
    throw new Error(migration.errors.map((error) => error.message).join('; '));
  }
  return parseReasoningConfiguration(migration.proposed);
}

export function createReasoningConfigurationFromProfileIds(
  profiles: Record<string, string>,
  defaults?: LegacyMigrationInput['defaults'],
): ReasoningConfiguration {
  const routeSettings = Object.fromEntries(Object.entries(profiles).map(([route, reasoningProfile]) => [route, {
    contextWindow: 1,
    reasoningProfile,
  }]));
  const migration = migrateLegacyReasoningAssignments({ routeSettings, defaults });
  const assignments = { ...migration.proposed.routeAssignments };
  const unresolved = migration.errors.filter((error) => {
    const id = profiles[error.route ?? ''];
    const builtIn = id ? getBuiltInProfile(id) : undefined;
    if (builtIn) {
      assignments[error.route!] = { activeProfile: getBuiltInProfileRef(id as Parameters<typeof getBuiltInProfileRef>[0]) };
      return false;
    }
    return true;
  });
  if (unresolved.length > 0) throw new Error(unresolved.map((error) => error.message).join('; '));
  for (const selected of [defaults?.global, ...Object.values(defaults?.groups ?? {})]) {
    if (!selected || !isPiReasoningLevel(selected.reasoning)) continue;
    const route = typeof selected.route === 'string' ? selected.route : typeof selected.defaultRoute === 'string' ? selected.defaultRoute : undefined;
    const assignment = route ? assignments[route] : undefined;
    if (!assignment) continue;
    const profile = getBuiltInProfile(assignment.activeProfile.id)!;
    if (!profile.supportedLevels.includes(selected.reasoning)) throw new Error(`Default level ${selected.reasoning} is not mapped by ${profile.id}`);
  }
  return parseReasoningConfiguration({ schemaVersion: 1, customProfileRevisions: [], routeAssignments: assignments });
}

export function reasoningConfigurationWarnings(configuration: ReasoningConfiguration): Array<{ code: string; message: string }> {
  const warnings: Array<{ code: string; message: string }> = [];
  for (const [route, assignment] of Object.entries(configuration.routeAssignments)) {
    const profile = getProfileForRef(configuration, assignment.activeProfile);
    const legs = assignment.legs ?? [];
    const evidenceIncomplete = !assignment.routeVersion || legs.length === 0 || legs.some((leg) => (
      leg.evidence?.current !== true
      || leg.evidence?.toolReplay !== true
      || leg.evidence?.ingress !== 'ai-gateway-chat-completions'
    ));
    if (profile.classification !== 'Verified' || evidenceIncomplete) {
      warnings.push({ code: 'reasoning_profile_unverified', message: `Route ${route} has incomplete or unverified profile evidence` });
    }
  }
  return warnings.filter((warning, index, all) => all.findIndex((candidate) => candidate.code === warning.code) === index);
}

export function builtInCatalog(): readonly NormalizedReasoningProfile[] {
  return BUILT_IN_REASONING_PROFILES;
}
