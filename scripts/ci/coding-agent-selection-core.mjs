export const CODING_AGENTS = Object.freeze([
  'claude-code',
  'codex',
  'copilot',
  'antigravity',
  'opencode',
  'pi',
]);

export const CODING_AGENT_ROOTS = Object.freeze({
  'claude-code': '.claude/',
  codex: '.codex/',
  copilot: '.copilot/',
  antigravity: '.gemini/',
  opencode: '.config/opencode/',
  pi: '.pi/agent/',
});

const DEFAULT_SELECTION = CODING_AGENTS.join(',');
const PROJECTION_SCHEMA_VERSION = 1;

/** Resolve an external comma-separated selection into stable canonical order. */
export function resolveCodingAgents(rawSelection) {
  if (rawSelection === undefined || rawSelection === null) return DEFAULT_SELECTION;
  if (typeof rawSelection !== 'string') throw new Error('Coding-agent selection must be a string');
  const values = rawSelection.split(',').map((value) => value.trim());
  if (values.length === 0 || values.some((value) => value.length === 0)) {
    throw new Error('Select at least one coding agent');
  }
  const unknown = [...new Set(values.filter((value) => !CODING_AGENTS.includes(value)))];
  if (unknown.length > 0) throw new Error(`Unknown coding agent: ${unknown.join(', ')}`);
  const selected = new Set(values);
  return CODING_AGENTS.filter((agent) => selected.has(agent)).join(',');
}

export function hasCodingAgent(rawSelection, agent) {
  if (!CODING_AGENTS.includes(agent)) throw new Error(`Unknown coding agent: ${agent}`);
  return resolveCodingAgents(rawSelection).split(',').includes(agent);
}

/** Return the sole coding-agent owner for a managed path, or null for an unknown root. */
export function managedPathOwner(path) {
  for (const agent of CODING_AGENTS) {
    if (path.startsWith(CODING_AGENT_ROOTS[agent])) return agent;
  }
  return null;
}

export function codingAgentProjectionIdentity(rawSelection) {
  return `v${PROJECTION_SCHEMA_VERSION}:${resolveCodingAgents(rawSelection)}`;
}

export function isCodingAgentProjectionIdentity(value) {
  if (typeof value !== 'string' || !value.startsWith(`v${PROJECTION_SCHEMA_VERSION}:`)) return false;
  try {
    const selection = value.slice(value.indexOf(':') + 1);
    return value === codingAgentProjectionIdentity(selection);
  } catch {
    return false;
  }
}
