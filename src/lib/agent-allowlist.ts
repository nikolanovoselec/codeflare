/**
 * Agent allowlist resolution.
 *
 * Enterprise deploys restrict the selectable agent set to those whose LLM
 * traffic can be routed through the customer's AI Gateway with zero manual
 * login (REQ-ENTERPRISE-003). Within that gateway-routable universe the admin
 * narrows the offering from the Setup wizard (KV `setup:active_agents`, REQ-ENTERPRISE-025).
 * Every mode also intersects that policy with the build-installed `CODING_AGENTS`
 * set (REQ-OPS-038); `bash` needs no package and is always selectable. This is a
 * runtime filter, NOT an enum change.
 */
import { AgentTypeSchema, type AgentType, type Env } from '../types';
import { isEnterpriseMode } from './subscription';
import { SETUP_KEYS } from './kv-keys';

/** Agents usable in enterprise mode — the selectable universe the Setup wizard
 * narrows. OpenAI-wire-format agents only: their traffic routes through the AI
 * Gateway REST API (REQ-ENTERPRISE-004). Claude Code is excluded — it speaks
 * the Anthropic-native wire format, which the gateway REST transport does not
 * carry (AD74). `bash` needs no LLM. Adding a future gateway-routable agent
 * means appending it here — wizard options, validation, and resolution all
 * derive from this list. Internal to this module; consumers use
 * {@link CONFIGURABLE_ENTERPRISE_AGENTS} and {@link allowedAgents}. */
const ENTERPRISE_AGENTS = ['copilot', 'pi', 'bash'] as const satisfies readonly AgentType[];

/** The wizard-governable subset of {@link ENTERPRISE_AGENTS}: the coding
 * agents. `bash` is a plain terminal (tabs 2-6 are bash in every session), so
 * deactivating it would remove nothing — it stays always-on. */
export const CONFIGURABLE_ENTERPRISE_AGENTS: readonly AgentType[] = ENTERPRISE_AGENTS.filter((a) => a !== 'bash');

const CODING_AGENT_TYPES = AgentTypeSchema.options.filter((agent) => agent !== 'bash');

/** Resolve build-installed agents in canonical schema order. Invalid external
 * configuration fails closed to bash; an absent value preserves all agents. */
export function installedAgents(env: Pick<Env, 'CODING_AGENTS'> | undefined): readonly AgentType[] {
  if (env?.CODING_AGENTS === undefined) return AgentTypeSchema.options;
  const requested = env.CODING_AGENTS.split(',').map((value) => value.trim()).filter(Boolean);
  if (requested.length === 0 || requested.some((value) => !CODING_AGENT_TYPES.includes(value as AgentType))) {
    return ['bash'];
  }
  const selected = new Set(requested);
  return AgentTypeSchema.options.filter((agent) => agent === 'bash' || selected.has(agent));
}

/**
 * Read + sanitize the wizard-selected active coding agents (REQ-ENTERPRISE-025).
 * Canonical {@link CONFIGURABLE_ENTERPRISE_AGENTS} order is preserved regardless
 * of stored order. Returns null when the key is absent, malformed, or holds no
 * configurable agent — callers fall back to the full enterprise set so
 * pre-feature deploys are unchanged and the set can never resolve empty.
 */
export async function readActiveAgents(kv: Env['KV']): Promise<readonly AgentType[] | null> {
  try {
    const stored = await kv.get<unknown>(SETUP_KEYS.ACTIVE_AGENTS, 'json');
    if (!Array.isArray(stored)) return null;
    const active = CONFIGURABLE_ENTERPRISE_AGENTS.filter((a) => stored.includes(a));
    return active.length > 0 ? active : null;
  } catch {
    return null;
  }
}

/**
 * Resolve the set of agent types selectable under the current deploy mode.
 * Enterprise policy and the build-installed set are intersected; outside
 * enterprise mode only the build-installed set applies. Bash remains available.
 */
export async function allowedAgents(
  env: Pick<Env, 'CODING_AGENTS' | 'ENTERPRISE_MODE' | 'KV'> | undefined,
): Promise<readonly AgentType[]> {
  const installed = installedAgents(env);
  if (!env || !isEnterpriseMode(env)) return installed;
  const active = await readActiveAgents(env.KV);
  const enterprise = active === null
    ? ENTERPRISE_AGENTS
    : ENTERPRISE_AGENTS.filter((agent) => agent === 'bash' || active.includes(agent));
  return enterprise.filter((agent) => installed.includes(agent));
}
