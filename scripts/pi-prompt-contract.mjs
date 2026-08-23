export const PI_PROMPT_BASELINE_CHARS = 32_416;
export const PI_PROMPT_MAX_CHARS = 14_000;

const DESTINATIONS = new Set([
  'SYSTEM.md',
  'AGENTS.md',
  'lazy-skill',
  'tool-schema',
  'runtime-guard',
  'evidence-backed-removal',
]);

function requireNonNegativeInteger(value, label) {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${label} must be a non-negative integer`);
  }
  return value;
}

export function measurePiPromptBudget({ controlledPrompt, additiveProjectContext, serializedToolSchemas }) {
  if (typeof controlledPrompt !== 'string') {
    throw new TypeError('controlledPrompt must be a string');
  }
  if (typeof additiveProjectContext !== 'string') {
    throw new TypeError('additiveProjectContext must be a string');
  }
  if (typeof serializedToolSchemas !== 'string') {
    throw new TypeError('serializedToolSchemas must be a string');
  }

  const promptChars = controlledPrompt.length;
  const projectContextChars = additiveProjectContext.length;
  const toolSchemaChars = serializedToolSchemas.length;
  return Object.freeze({
    promptChars,
    projectContextChars,
    toolSchemaChars,
    maxPromptChars: PI_PROMPT_MAX_CHARS,
    withinPromptBudget: promptChars <= PI_PROMPT_MAX_CHARS,
    reductionFromBaselineChars: PI_PROMPT_BASELINE_CHARS - promptChars,
    reductionFromBaselinePercent:
      ((PI_PROMPT_BASELINE_CHARS - promptChars) / PI_PROMPT_BASELINE_CHARS) * 100,
  });
}

export function validatePiPromptBaseline(fixture) {
  if (!fixture || typeof fixture !== 'object' || Array.isArray(fixture)) {
    throw new TypeError('baseline fixture must be an object');
  }
  const components = fixture.components;
  if (!components || typeof components !== 'object' || Array.isArray(components)) {
    throw new TypeError('baseline components must be an object');
  }
  const componentTotal = Object.entries(components).reduce(
    (sum, [name, value]) => sum + requireNonNegativeInteger(value, `components.${name}`),
    0,
  );
  const totalChars = requireNonNegativeInteger(fixture.totalChars, 'totalChars');
  if (totalChars !== PI_PROMPT_BASELINE_CHARS || componentTotal !== totalChars) {
    throw new Error('baseline component total must equal the captured 32,416-character prompt');
  }
  if (fixture.projectContext?.includedInPromptChars !== false) {
    throw new Error('additive project context must be measured outside the controlled prompt budget');
  }
  if (fixture.toolSchemas?.includedInPromptChars !== false) {
    throw new Error('serialized tool schemas must be measured outside the prompt budget');
  }
  return Object.freeze({ totalChars, componentTotal });
}

export function validatePiPromptRuleLedger(ledger) {
  if (!ledger || typeof ledger !== 'object' || Array.isArray(ledger)) {
    throw new TypeError('rule ledger must be an object');
  }
  if (ledger.baselineChars !== PI_PROMPT_BASELINE_CHARS || ledger.maxPromptChars !== PI_PROMPT_MAX_CHARS) {
    throw new Error('rule ledger must pin the captured baseline and 14,000-character cap');
  }
  if (ledger.coverageGuarantee !== 'controlled-surface-categories'
    || ledger.projectContextMeasuredSeparately !== true
    || ledger.toolSchemasMeasuredSeparately !== true) {
    throw new Error('rule ledger must cover controlled surface categories and report additive inputs separately');
  }
  if (!Array.isArray(ledger.ownership?.['codeflare-curation'])
    || !ledger.ownership['codeflare-curation'].includes('complete managed policy inventory')) {
    throw new Error('rule ledger must assign the complete managed policy inventory to curation');
  }
  if (Object.hasOwn(ledger.ownership, 'sharedFlow')) {
    throw new Error('rule ledger must not declare shared-preseed policy flow');
  }
  if (ledger.ownership?.reversePrivateSync !== false) {
    throw new Error('private curation content must never reverse-sync into Codeflare');
  }
  if (!Array.isArray(ledger.entries) || ledger.entries.length === 0) {
    throw new Error('rule ledger entries are required');
  }

  const ids = new Set();
  for (const entry of ledger.entries) {
    if (typeof entry.id !== 'string' || entry.id.length === 0 || ids.has(entry.id)) {
      throw new Error(`rule ledger entry IDs must be unique: ${entry.id ?? ''}`);
    }
    ids.add(entry.id);
    if (!Array.isArray(entry.covers) || entry.covers.length === 0 || entry.covers.some((item) => typeof item !== 'string' || item.length === 0)) {
      throw new Error(`rule ledger entry ${entry.id} must name its covered source instructions`);
    }
    if (!DESTINATIONS.has(entry.destination)) {
      throw new Error(`rule ledger entry ${entry.id} has no retained destination`);
    }
    if (typeof entry.owner !== 'string' || entry.owner.length === 0) {
      throw new Error(`rule ledger entry ${entry.id} must have one owner`);
    }
  }
  return Object.freeze({ entryCount: ledger.entries.length, ids });
}
