/**
 * Agent allowlist resolution.
 *
 * Enterprise deploys restrict the selectable agent set to those whose LLM
 * traffic can be routed through the customer's AI Gateway with zero manual
 * login (REQ-ENTERPRISE-003). Within that gateway-routable universe the admin
 * narrows the offering from the Setup wizard (KV `setup:active_agents`, REQ-ENTERPRISE-025);
 * `bash` needs no LLM and is always selectable. Outside enterprise mode, all
 * agents defined by {@link AgentTypeSchema} remain available — this is a
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
 * Enterprise ⇒ the wizard-selected active coding agents plus the always-on
 * `bash`; an absent/invalid stored value falls back to the full
 * {@link ENTERPRISE_AGENTS}. Otherwise the full agent enum.
 */
export async function allowedAgents(env: Pick<Env, 'ENTERPRISE_MODE' | 'KV'> | undefined): Promise<readonly AgentType[]> {
  if (!env || !isEnterpriseMode(env)) return AgentTypeSchema.options;
  const active = await readActiveAgents(env.KV);
  if (active === null) return ENTERPRISE_AGENTS;
  return ENTERPRISE_AGENTS.filter((a) => a === 'bash' || active.includes(a));
}
