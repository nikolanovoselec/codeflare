export type CodingAgent = 'claude-code' | 'codex' | 'copilot' | 'antigravity' | 'opencode' | 'pi';

export declare const CODING_AGENTS: readonly CodingAgent[];
export declare const CODING_AGENT_ROOTS: Readonly<Record<CodingAgent, string>>;

export function resolveCodingAgents(rawSelection?: unknown): string;
export function hasCodingAgent(rawSelection: unknown, agent: CodingAgent): boolean;
export function managedPathOwner(path: string): CodingAgent | null;
export function codingAgentProjectionIdentity(rawSelection?: unknown): string;
export function isCodingAgentProjectionIdentity(value: unknown): boolean;
