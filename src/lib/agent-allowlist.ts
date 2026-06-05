/**
 * Agent allowlist resolution.
 *
 * Enterprise deploys restrict the selectable agent set to those whose LLM
 * traffic can be routed through the customer's AI Gateway with zero manual
 * login (REQ-ENTERPRISE-003). Outside enterprise mode, all agents defined by
 * {@link AgentTypeSchema} remain available — this is a runtime filter, NOT an
 * enum change.
 */
import { AgentTypeSchema, type AgentType, type Env } from '../types';
import { isEnterpriseMode } from './subscription';

/** Agents permitted in enterprise mode. Internal to this module (consumed by
 * {@link allowedAgents}); not exported — the frontend keeps its own copy.
 * OpenAI-wire-format agents only: their traffic routes through the AI Gateway
 * REST API (REQ-ENTERPRISE-004). Claude Code is excluded — it speaks the
 * Anthropic-native wire format, which the gateway REST transport does not carry
 * (AD74). `bash` needs no LLM. */
const ENTERPRISE_AGENTS = ['copilot', 'pi', 'bash'] as const satisfies readonly AgentType[];

/**
 * Resolve the set of agent types selectable under the current deploy mode.
 * Enterprise ⇒ {@link ENTERPRISE_AGENTS}; otherwise the full agent enum.
 */
export function allowedAgents(env: Pick<Env, 'ENTERPRISE_MODE'> | undefined): readonly AgentType[] {
  if (isEnterpriseMode(env)) return ENTERPRISE_AGENTS;
  return AgentTypeSchema.options;
}
