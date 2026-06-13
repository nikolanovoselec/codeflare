/**
 * Type declarations for the plain-JS Browser Run core (core.mjs).
 *
 * core.mjs ships standalone inside the container image (no TS toolchain there), so
 * it stays plain JS. This co-located declaration lets the TS backend type-check —
 * and src/__tests__/lib/browser-run-core.test.ts — import the Claude twin without
 * an implicit-any error. It only describes the module's shape; the runtime logic
 * lives in core.mjs, and the equivalence test guards that the twin matches the Pi
 * helper (preseed/agents/pi/extensions/browser-run-helpers.ts), the typed source.
 */
type FetchLike = (
  url: string,
  init: unknown,
) => Promise<{ ok: boolean; status: number; json: () => Promise<unknown> }>;

export const MAX_OUTPUT_CHARS: number;
export function truncate(text: string): string;
export function gotoOptions(waitUntil?: string): Record<string, unknown>;
export function emptyRenderText(url: string): string;

export type QuickActionResult = { ok: true; result: unknown } | { ok: false; error: string };
export type BrowserActionOutcome = { text: string; isError?: boolean; details: Record<string, unknown> };

export function runQuickAction(opts: {
  accountId: string;
  token: string;
  action: string;
  body: Record<string, unknown>;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}): Promise<QuickActionResult>;

export function executeBrowserAction(opts: {
  tool: string;
  params: { url: string; selectors?: string[]; wait_until?: string };
  accountId: string;
  token: string;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}): Promise<BrowserActionOutcome>;

export const TOOLS: Array<{
  name: string;
  description: string;
  inputSchema: { type: string; properties: Record<string, unknown>; required?: string[] };
}>;
export const TOOL_NAMES: Set<string>;
