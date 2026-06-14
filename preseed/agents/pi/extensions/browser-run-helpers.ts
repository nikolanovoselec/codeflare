/**
 * Pure Browser Run REST logic (REQ-BROWSER-003), extracted from browser-run.ts so
 * it carries no Pi-runtime imports and can be unit-tested directly (the same
 * pattern as graphify-helpers.ts). browser-run.ts keeps only the typebox tool
 * definitions and thin execute() wrappers that call executeBrowserAction here.
 *
 * The Claude-side MCP server (preseed/agents/claude/browser-run-mcp/core.mjs) is
 * a byte-for-byte twin of this logic; src/__tests__/lib/browser-run-core.test.ts
 * runs one assertion battery against BOTH and asserts they are equivalent, so the
 * two runtimes cannot silently drift.
 */
const API_BASE = "https://api.cloudflare.com/client/v4/accounts";
// Browser Run can return very large pages; cap tool output so a single fetch
// cannot blow up the agent's context window. Truncation is flagged in the text.
export const MAX_OUTPUT_CHARS = 120_000;

export type QuickActionResult = { ok: true; result: unknown } | { ok: false; error: string };
export type BrowserActionOutcome = { text: string; isError?: boolean; details: Record<string, unknown> };
type FetchLike = (input: string, init: Record<string, unknown>) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

export function truncate(text: string): string {
  // Fast path: UTF-16 length <= cap implies code-point count <= cap, so the
  // string is safely under budget and needs no slicing.
  if (text.length <= MAX_OUTPUT_CHARS) return text;
  // Slice on code points (not UTF-16 units) so we never cut a surrogate pair in
  // half on emoji/CJK-heavy pages.
  const chars = Array.from(text);
  if (chars.length <= MAX_OUTPUT_CHARS) return text;
  return `${chars.slice(0, MAX_OUTPUT_CHARS).join("")}\n\n[... truncated ${
    chars.length - MAX_OUTPUT_CHARS
  } chars; narrow the request or use browser_scrape with a CSS selector ...]`;
}

export function gotoOptions(waitUntil?: string): Record<string, unknown> {
  return waitUntil ? { gotoOptions: { waitUntil } } : {};
}

// A successful-but-empty render is usually a JS-heavy page that had not painted
// by capture time. The hint is actionable text, not a thrown error.
export function emptyRenderText(url: string): string {
  return `Browser Run returned an empty page for ${url}. The page likely renders content after load — retry with wait_until: "networkidle0".`;
}

export async function runQuickAction(opts: {
  accountId: string;
  token: string;
  action: string;
  body: Record<string, unknown>;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}): Promise<QuickActionResult> {
  const { accountId, token, action, body, signal, fetchImpl } = opts;
  const doFetch = (fetchImpl ?? (fetch as unknown as FetchLike));
  try {
    const res = await doFetch(`${API_BASE}/${accountId}/browser-rendering/${action}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal,
    });
    const data = (await res.json().catch(() => null)) as
      | { success?: boolean; result?: unknown; errors?: unknown }
      | null;
    if (!res.ok || !data || data.success === false) {
      const detail = data ? JSON.stringify(data.errors ?? data) : `HTTP ${res.status}`;
      return { ok: false, error: `Browser Run /${action} failed: ${detail}` };
    }
    return { ok: true, result: data.result };
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return { ok: false, error: "aborted" };
    return {
      ok: false,
      error: `Browser Run /${action} request error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Run one Browser Run tool end to end and return a runtime-agnostic outcome.
 * browser_markdown/browser_content return the page text (Markdown/HTML); an empty
 * render becomes an actionable hint. browser_scrape returns the matched elements
 * as pretty JSON. Errors come back as { isError: true }, never thrown.
 */
export async function executeBrowserAction(opts: {
  tool: string;
  params: { url: string; selectors?: string[]; wait_until?: string };
  accountId: string;
  token: string;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
}): Promise<BrowserActionOutcome> {
  const { tool, params, accountId, token, signal, fetchImpl } = opts;
  if (tool === "browser_scrape") {
    const elements = (params.selectors ?? []).map((selector) => ({ selector }));
    const r = await runQuickAction({
      accountId,
      token,
      action: "scrape",
      body: { url: params.url, elements, ...gotoOptions(params.wait_until) },
      signal,
      fetchImpl,
    });
    if (!r.ok) return { text: r.error, isError: true, details: {} };
    return {
      text: truncate(JSON.stringify(r.result, null, 2)),
      details: { url: params.url, selectors: params.selectors },
    };
  }
  const action = tool === "browser_markdown" ? "markdown" : "content";
  const r = await runQuickAction({
    accountId,
    token,
    action,
    body: { url: params.url, ...gotoOptions(params.wait_until) },
    signal,
    fetchImpl,
  });
  if (!r.ok) return { text: r.error, isError: true, details: {} };
  const text = String(r.result ?? "");
  if (text.trim() === "") return { text: emptyRenderText(params.url), details: { url: params.url, empty: true } };
  return { text: truncate(text), details: { url: params.url } };
}

/**
 * Helper module for browser-run.ts; the named helpers above are imported there.
 * The Pi extension scanner loads every file in extensions/ and requires a default
 * factory, so expose a no-op one (matching the other *-helpers.ts modules) rather
 * than registering anything. Without it, Pi fails to start with "Extension does
 * not export a valid factory function".
 */
export default function () {
  // Helper module only; loaded by the Pi extension scanner as a no-op extension.
}
