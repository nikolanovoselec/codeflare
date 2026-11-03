/** File-only retention. No SessionManager/cache mutation; ordinary SDK appends reopen this pathname. */
import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { isDeepStrictEqual, TextDecoder } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export const TRANSCRIPT_TRIM_DUE = "codeflare:transcript-trim-due";
const CAP = 50_000_000;
const TARGET = 20_000_000;
type Entry = Record<string, any>;
type Identity = { sessionId: string; file: string };
type TrimContext = Pick<ExtensionContext, "sessionManager">;
export type TrimResult = { status: "trimmed" | "unchanged" | "refused"; before?: number; after?: number; reason?: string };

function identity(ctx: TrimContext): Identity | undefined {
  const sessionId = ctx.sessionManager.getSessionId();
  const file = ctx.sessionManager.getSessionFile();
  return sessionId && file && isAbsolute(file) ? { sessionId, file } : undefined;
}
function same(a: Identity | undefined, b: Identity | undefined): boolean {
  return !!a && !!b && a.sessionId === b.sessionId && a.file === b.file;
}
function todo(e: Entry): boolean {
  return e.type === "custom" && e.customType === "rpiv-todo-state";
}
function snapshot(d: any): boolean {
  return !!d && Array.isArray(d.tasks) && typeof d.nextId === "number" && Number.isFinite(d.nextId);
}
function encode(e: Entry): string { return JSON.stringify(e) + "\n"; }

/** Strict complete JSONL; parents must precede children. Unknown records remain opaque. */
export function parseTranscript(raw: string, sessionId: string): Entry[] {
  if (!raw.endsWith("\n")) throw new Error("incomplete-or-invalid-jsonl");
  const entries = raw.slice(0, -1).split("\n").map(line => JSON.parse(line));
  const header = entries[0];
  if (!header || header.type !== "session" || header.id !== sessionId || header.parentSession) throw new Error("foreign-or-child-session");
  if (header.version !== 3) throw new Error("unsupported-session-version");
  const ids = new Set<string>();
  for (const e of entries.slice(1)) {
    if (!e || typeof e !== "object" || Array.isArray(e) || e.type === "session"
      || typeof e.type !== "string" || typeof e.id !== "string" || !e.id || e.id === header.id || ids.has(e.id)
      || !(e.parentId === null || (typeof e.parentId === "string" && ids.has(e.parentId)))) throw new Error("invalid-entry-links");
    ids.add(e.id);
    if (todo(e) && !snapshot(e.data)) throw new Error("invalid-todo-state");
  }
  for (const e of entries.slice(1)) {
    if (e.type === "compaction" && !ids.has(e.firstKeptEntryId)) throw new Error("invalid-compaction-boundary");
  }
  return entries;
}

/** Pure candidate builder. Untouched lines, including opaque state, remain byte-identical. */
export function prepareTranscript(raw: string, sessionId: string, branchIds: string[]): string | undefined {
  const entries = parseTranscript(raw, sessionId);
  const lines = raw.slice(0, -1).split("\n").map(line => line + "\n");
  let size = Buffer.byteLength(raw);
  if (size <= CAP) return undefined;
  const byId = new Map(entries.slice(1).map((e, i) => [e.id, i + 1]));
  if (branchIds.length === 0 || branchIds.some((id, i) => !byId.has(id)
    || entries[byId.get(id)!].parentId !== (i ? branchIds[i - 1] : null))) throw new Error("foreign-branch");
  const nearest = new Map<string, string | undefined>();
  const children = new Map<string, number>();
  const keep = new Set<string>();
  const checkpoints = new Set<string>();
  for (const e of entries.slice(1)) children.set(e.parentId, (children.get(e.parentId) ?? 0) + 1);
  for (const e of entries.slice(1)) nearest.set(e.id, todo(e) ? e.id : nearest.get(e.parentId));
  const retain = (id: string) => {
    if (!id) return;
    checkpoints.add(id);
    const state = nearest.get(id);
    if (state) keep.add(state);
  };
  for (const e of entries.slice(1)) {
    if (children.get(e.id) !== 1) retain(e.id);
    if (e.type === "compaction") { retain(e.id); retain(e.parentId); retain(e.firstKeptEntryId); }
  }
  retain(branchIds[branchIds.length - 1]);
  const changes = new Map<number, string>();
  const replace = (i: number, e: Entry) => {
    const next = encode(e);
    const previous = changes.get(i) ?? lines[i];
    if (Buffer.byteLength(next) >= Buffer.byteLength(previous)) return;
    size += Buffer.byteLength(next) - Buffer.byteLength(previous);
    changes.set(i, next);
  };
  // Renderer duplicates are not conversation content. Legacy tool-only branches remain intact.
  for (let i = 1; i < entries.length && size > TARGET; i++) {
    const e = entries[i], m = e.message;
    const stateId = nearest.get(e.parentId);
    const state = stateId ? entries[byId.get(stateId)!].data : undefined;
    if (e.type === "message" && m?.role === "toolResult" && m.toolName === "todo" && snapshot(m.details)
      && state && isDeepStrictEqual([m.details.tasks, m.details.nextId], [state.tasks, state.nextId])) {
      const { details: _details, ...message } = m;
      replace(i, { ...e, message });
    }
  }
  for (let i = 1; i < entries.length && size > TARGET; i++) {
    const e = entries[i];
    if (todo(e) && !keep.has(e.id)) replace(i, { ...e, customType: "codeflare.transcript-trimmed", data: {
      originalCustomType: "rpiv-todo-state", reason: "Superseded historical snapshot; authoritative branch checkpoints retained.",
    } });
  }
  // A summary covers only its ancestry, not earlier records on other branches.
  const covered = (ids: string[]): Set<string> => {
    const compactAt = ids.findLastIndex(id => entries[byId.get(id)!].type === "compaction");
    if (compactAt < 0) return new Set();
    const firstKept = ids.indexOf(entries[byId.get(ids[compactAt])!].firstKeptEntryId);
    return firstKept < 0 || firstKept > compactAt ? new Set() : new Set(ids.slice(0, firstKept));
  };
  const eligible = covered(branchIds);
  // Other leaves and branchpoints can reopen without the active branch's summary.
  for (const e of entries.slice(1)) {
    if (children.get(e.id) === 1) continue;
    const ids: string[] = [];
    for (let id: string | null = e.id; id; id = entries[byId.get(id)!].parentId) ids.push(id);
    ids.reverse();
    const summarized = covered(ids);
    for (const id of ids) if (!summarized.has(id)) eligible.delete(id);
  }
  for (let i = 1; i < entries.length && size > TARGET; i++) {
    const e = entries[i], m = e.message;
    if (eligible.has(e.id) && e.type === "message" && m?.role === "assistant" && Array.isArray(m.content)
      && m.content.some((block: any) => block?.type === "thinking")) {
      replace(i, { ...e, message: { ...m, content: m.content.map((block: any) => block?.type === "thinking"
        ? { type: "thinking", thinking: "[Historical reasoning trimmed.]" } : block) } });
    }
  }
  // Only completed built-in raw results with no structured/state-bearing fields are eligible.
  const calls = new Map<string, { index: number; name: string }>();
  for (let i = 1; i < entries.length; i++) {
    const m = entries[i].message;
    if (m?.role === "assistant" && Array.isArray(m.content)) for (const b of m.content) {
      if (b?.type === "toolCall") calls.set(b.id, { index: i, name: b.name });
    }
  }
  for (let i = 1; i < entries.length && size > TARGET; i++) {
    const e = entries[i], m = e.message, call = calls.get(m?.toolCallId);
    if (!eligible.has(e.id) || e.type !== "message" || m?.role !== "toolResult" || !["read", "bash"].includes(m.toolName)
      || !call || call.index >= i || call.name !== m.toolName
      || m.details !== undefined || m.structuredContent !== undefined || !Array.isArray(m.content)
      || !m.content.every((b: any) => b?.type === "text" || b?.type === "image")) continue;
    let ancestor = e.parentId;
    while (ancestor && ancestor !== entries[call.index].id) ancestor = entries[byId.get(ancestor)!].parentId;
    if (!ancestor) continue;
    replace(i, { ...e, message: { ...m, content: [{ type: "text", text: "[Historical raw tool output trimmed.]" }] } });
  }
  if (size >= CAP || changes.size === 0) return undefined;
  const candidate = lines.map((line, i) => changes.get(i) ?? line).join("");
  const checked = parseTranscript(candidate, sessionId);
  for (let i = 0; i < entries.length; i++) {
    if (entries[i].id !== checked[i].id || entries[i].parentId !== checked[i].parentId) throw new Error("changed-envelope");
    if (keep.has(entries[i].id) && !isDeepStrictEqual(entries[i], checked[i])) throw new Error("changed-checkpoint");
  }
  // Re-evaluate Todo authority at branchpoints, leaves, active leaf and compaction checkpoints.
  const restored = new Map<string, string | undefined>();
  for (const e of checked.slice(1)) restored.set(e.id, todo(e) ? e.id : restored.get(e.parentId));
  for (const checkpoint of checkpoints) {
    if (restored.get(checkpoint) !== nearest.get(checkpoint)) throw new Error("lost-checkpoint");
  }
  return candidate;
}

function pathIdentity(file: string, io: typeof fs): string {
  if (resolve(file) !== file) throw new Error("unsafe-path");
  const root = parse(file).root;
  let current = root;
  const parts = resolve(file).slice(root.length).split("/");
  return [root, ...parts].map((part, i) => {
    if (i) current = join(current, part);
    const s = io.lstatSync(current);
    if (s.isSymbolicLink() || (i < parts.length ? !s.isDirectory() : !s.isFile())) throw new Error("unsafe-path");
    return `${s.dev}:${s.ino}`;
  }).join("/");
}
function sourceIdentity(s: fs.Stats): string { return `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.uid}:${s.gid}:${s.mode}:${s.nlink}`; }

/** Entire operation is synchronous/non-yielding: ordinary same-event-loop SDK appends cannot interleave.
 * Does not provide a transaction against arbitrary external processes. io injection is for synthetic FS failures.
 */
export function trimActiveSessionTranscript(ctx: TrimContext, expected: Identity, io: typeof fs = fs): TrimResult {
  let temp: string | undefined;
  let committed = false;
  let ownedTemp = false;
  let before: number | undefined;
  try {
    if (!same(identity(ctx), expected)) throw new Error("session-changed");
    const pathStamp = pathIdentity(expected.file, io);
    const stat = io.lstatSync(expected.file);
    if (stat.uid !== process.getuid?.() || stat.nlink !== 1) throw new Error("foreign-ownership");
    before = stat.size;
    if (before <= CAP) return { status: "unchanged", before, after: before };
    const raw = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(io.readFileSync(expected.file));
    const leaf = ctx.sessionManager.getLeafId();
    const branch = ctx.sessionManager.getBranch().map(e => e.id);
    if (branch.at(-1) !== leaf) throw new Error("session-changed");
    const candidate = prepareTranscript(raw, expected.sessionId, branch);
    if (!candidate) return { status: "unchanged", before, after: before, reason: "protected-state-floor" };
    temp = join(dirname(expected.file), `.transcript-trim-${randomUUID()}.tmp`);
    const fd = io.openSync(temp, "wx", 0o600);
    ownedTemp = true;
    try {
      io.writeFileSync(fd, candidate, "utf8");
      io.fchownSync(fd, stat.uid, stat.gid);
      io.fchmodSync(fd, stat.mode & 0o7777);
      io.fsyncSync(fd);
    } finally { io.closeSync(fd); }
    const dir = io.openSync(dirname(expected.file), "r");
    try {
      if (!same(identity(ctx), expected) || ctx.sessionManager.getLeafId() !== leaf
        || !isDeepStrictEqual(ctx.sessionManager.getBranch().map(e => e.id), branch)
        || pathIdentity(expected.file, io) !== pathStamp
        || sourceIdentity(io.lstatSync(expected.file)) !== sourceIdentity(stat)) throw new Error("source-or-session-changed");
      io.renameSync(temp, expected.file);
      temp = undefined;
      committed = true;
      io.fsyncSync(dir);
    } finally { io.closeSync(dir); }
    return { status: "trimmed", before, after: Buffer.byteLength(candidate) };
  } catch {
    return { status: committed ? "trimmed" : "refused", before, reason: committed ? "directory-sync-failed" : "unsafe-or-failed-replacement" };
  } finally {
    if (temp && ownedTemp) { try { io.unlinkSync(temp); } catch { /* Only our exclusively-created staging pathname is eligible. */ } }
  }
}

export function registerActiveSessionTranscriptTrimming(pi: ExtensionAPI): void {
  let current: TrimContext | undefined;
  let pending: Identity | undefined;
  const cancel = () => { pending = undefined; current = undefined; };
  pi.on("session_start", (_event, ctx) => { cancel(); current = ctx; });
  pi.on("session_before_switch", cancel);
  pi.on("session_before_fork", cancel);
  pi.on("session_shutdown", cancel);
  pi.events.on(TRANSCRIPT_TRIM_DUE, data => {
    const due = data as Identity | undefined;
    if (due && current && same(identity(current), due)) pending = { sessionId: due.sessionId, file: due.file };
  });
  pi.on("agent_end", (event, ctx) => {
    const due = pending;
    pending = undefined;
    if (!due || !same(identity(ctx), due)) return;
    const last = [...event.messages].reverse().find(m => m.role === "assistant");
    // agent_end has no outcome field in 1.3/1.5. Require an explicit normal assistant stop;
    // a toolUse/length tail may be an interrupted or unfinished run.
    if (!last || last.stopReason !== "stop" || ctx.signal?.aborted) return;
    const result = trimActiveSessionTranscript(ctx, due);
    if (result.reason) console.warn(`[codeflare:transcript-trim] ${result.reason}`);
  });
}

export default function (pi: ExtensionAPI): void { registerActiveSessionTranscriptTrimming(pi); }
