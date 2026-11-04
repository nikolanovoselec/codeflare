/** File-only retention. No SessionManager/cache mutation; ordinary SDK appends reopen this pathname. */
import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { isDeepStrictEqual, TextDecoder } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { buildPublicTranscriptTrimRequest, extractionTranscriptFacts, extractionDue } from "./memory-vault-helpers";

const CAP = 50_000_000;
const MINIMUM = 15_000_000;
const TARGET = 20_000_000;
const MAXIMUM = 25_000_000;
// Leave room for the bounded parent-verified outcome entry itself.
const COMPLETION_RESERVE = 4096;
type Entry = Record<string, any>;
type Identity = { sessionId: string; file: string };
type TrimContext = { sessionManager: {
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getLeafId(): string | null;
  getBranch(): readonly Entry[];
  getHeader?(): { id: string; parentSession?: string } | null;
} };
export type TrimResult = { status: "trimmed" | "unchanged" | "refused" | "verification-pending"; before?: number; after?: number; reason?: string };

function identity(ctx: TrimContext): Identity | undefined {
  const sessionId = ctx.sessionManager.getSessionId?.();
  const file = ctx.sessionManager.getSessionFile?.();
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
function lastIndex<T>(entries: readonly T[], match: (entry: T) => boolean): number {
  for (let i = entries.length - 1; i >= 0; i--) if (match(entries[i])) return i;
  return -1;
}

/** Strict complete JSONL; parents must precede children. Unknown records remain opaque. */
export function parseTranscript(raw: string, sessionId: string, allowExistingGaps = false): Entry[] {
  if (!raw.endsWith("\n")) throw new Error("incomplete-or-invalid-jsonl");
  const entries = raw.slice(0, -1).split("\n").map(line => JSON.parse(line));
  const header = entries[0];
  if (!header || header.type !== "session" || header.id !== sessionId || header.parentSession) throw new Error("foreign-or-child-session");
  if (header.version !== 3) throw new Error("unsupported-session-version");
  const ids = new Set<string>();
  const allIds = new Set(entries.slice(1).map(e => e?.id));
  for (const e of entries.slice(1)) {
    if (!e || typeof e !== "object" || Array.isArray(e) || e.type === "session"
      || typeof e.type !== "string" || typeof e.id !== "string" || !e.id || e.id === header.id || ids.has(e.id)
      || !(e.parentId === null || (typeof e.parentId === "string" && (ids.has(e.parentId) || (allowExistingGaps && !allIds.has(e.parentId)))))) throw new Error("invalid-entry-links");
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
    const compactAt = lastIndex(ids, id => entries[byId.get(id)!].type === "compaction");
    if (compactAt < 0) return new Set();
    const firstKept = ids.indexOf(entries[byId.get(ids[compactAt])!].firstKeptEntryId);
    return firstKept < 0 || firstKept > compactAt ? new Set() : new Set(ids.slice(0, firstKept));
  };
  const eligible = covered(branchIds);
  // Mark unsummarized endpoint paths in one tree pass, rather than rebuilding
  // every ancestry in repeatedly forked histories. Index 0 is the virtual root.
  const parents = new Int32Array(entries.length);
  const descendants: number[][] = entries.map(() => []);
  for (let i = 1; i < entries.length; i++) {
    const parent = byId.get(entries[i].parentId) ?? 0;
    parents[i] = parent;
    descendants[parent].push(i);
  }
  const boundaries = new Int32Array(entries.length);
  const onPath = new Uint8Array(entries.length);
  const protection = new Int32Array(entries.length);
  const visit: Array<[number, boolean]> = [[0, false]];
  while (visit.length) {
    const [i, leaving] = visit.pop()!;
    if (leaving) { onPath[i] = 0; continue; }
    onPath[i] = 1;
    if (i) {
      const first = byId.get(entries[i].firstKeptEntryId) ?? 0;
      boundaries[i] = entries[i].type === "compaction" ? (onPath[first] && first ? first : 0) : boundaries[parents[i]];
      if (descendants[i].length !== 1) {
        protection[i]++;
        if (boundaries[i]) protection[parents[boundaries[i]]]--;
      }
    }
    visit.push([i, true]);
    for (const child of descendants[i]) visit.push([child, false]);
  }
  // Parents precede children in validated JSONL, so reverse order accumulates
  // each path mark once. Invalid compaction ancestry conservatively protects it.
  for (let i = entries.length - 1; i > 0; i--) {
    if (protection[i] > 0) eligible.delete(entries[i].id);
    protection[parents[i]] += protection[i];
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

/** Metadata only: never a copy of the original transcript. Candidate path is parent-owned. */
export interface TranscriptTrimRequest {
  version: 1;
  requestId: string;
  sessionId: string;
  file: string;
  sourceBytes: number;
  sourceSha256: string;
  sourcePathIdentity: string;
  branchIds: string[];
  targetBytes: number;
  candidateBudget: number;
  directory: string;
  directoryIdentity: string;
  varsFile: string;
  candidateFile: string;
  feedback: string;
  committed?: { sha256: string; bytes: number; before: number; warning?: string };
}
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const decode = (bytes: Buffer) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
const stateTypes = new Set(["rpiv-todo-state", "goal-state", "plan-mode-state"]);

/** Eligibility is not lossless restoration of every historical branch checkpoint.
 * Protect the current active conversation/frontier and latest known authority;
 * the semantic agent may condense superseded payloads on inactive branches. */
function activeHistory(entries: Entry[], branchIds: string[] = []): { active: number[]; start: number; frontierId?: string } {
  const index = new Map(entries.slice(1).map((e, i) => [e.id, i + 1]));
  const leaf = branchIds.at(-1) ?? entries.at(-1)?.id;
  if (leaf && !index.has(leaf) && entries.length > 1) throw new Error("foreign-active-leaf");
  let active: number[];
  if (branchIds.length) {
    if (new Set(branchIds).size !== branchIds.length || branchIds.some((id, i) => i > 0 && index.has(id)
      && entries[index.get(id)!].parentId !== branchIds[i - 1])) throw new Error("foreign-branch-projection");
    // Keep the full loaded ancestry as authority; project only persisted records.
    // Missing records are never restored, and a disk gap cannot hide current context.
    active = branchIds.map(id => index.get(id)).filter((i): i is number => i !== undefined);
  } else {
    active = [];
    for (let i = index.get(leaf); i; i = index.get(entries[i].parentId)) active.push(i);
    active.reverse();
  }
  const compactAt = lastIndex(active, i => entries[i].type === "compaction");
  const firstKept = compactAt >= 0 ? active.findIndex(i => entries[i].id === entries[active[compactAt]].firstKeptEntryId) : -1;
  const valid = firstKept >= 0 && firstKept <= compactAt;
  return { active, start: valid ? firstKept : 0, ...(valid ? { frontierId: entries[active[firstKept]].id } : {}) };
}
function historicalEligibility(entries: Entry[], branchIds: string[] = []): Set<string> {
  const { active, start } = activeHistory(entries, branchIds);
  const keep = new Set(active.slice(start));
  const compactAt = lastIndex(active, i => entries[i].type === "compaction");
  // SDK buildContextEntries excludes pre-checkpoint system deltas; its projection
  // also ignores older compactions inside the retained range.
  for (let position = 0; position < compactAt; position++) {
    const i = active[position], entry = entries[i];
    if (entry.type === "compaction" || (entry.type === "message" && entry.message?.role === "system")) keep.delete(i);
  }
  const latestCheckpoint = lastIndex(entries, entry => entry.type === "compaction");
  if (latestCheckpoint > 0) keep.add(latestCheckpoint);
  for (const type of stateTypes) {
    const global = lastIndex(entries, e => e.type === "custom" && e.customType === type);
    const branchIndex = lastIndex(active, i => entries[i].type === "custom" && entries[i].customType === type);
    const onBranch = branchIndex < 0 ? undefined : active[branchIndex];
    if (global > 0) keep.add(global);
    if (onBranch !== undefined) keep.add(onBranch);
  }
  return new Set(entries.slice(1).filter((entry, i) => !keep.has(i + 1)
    && ((entry.type === "custom" && stateTypes.has(entry.customType)) || entry.type === "compaction"
      || (entry.type === "message" && ["assistant", "system", "toolResult"].includes(entry.message?.role)))).map(e => e.id));
}

// Superseded task snapshots are internal metadata, not current message content.
// Keep the latest global and active-branch authority, even inside the frontier.
function supersededTodoData(entries: Entry[], branchIds: string[]): Set<string> {
  const active = new Set(activeHistory(entries, branchIds).active.map(i => entries[i].id));
  const global = lastIndex(entries, todo);
  const branch = lastIndex(entries, e => active.has(e.id) && todo(e));
  return new Set(entries.filter((entry, i) => {
    if (todo(entry)) return i !== global && i !== branch;
    return entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === "todo"
      && snapshot(entry.message.details) && i < global && (!active.has(entry.id) || i < branch);
  }).map(entry => entry.id));
}

function obsoleteSystemPayload(message: any): any {
  if (!message || message.role !== "system") return message;
  const content = Array.isArray(message.content)
    ? message.content.filter((block: any) => !sameHistoricalBlocks([block], [])) : [];
  return { ...message, content,
    ...(Array.isArray(message.toolsAdded) ? { toolsAdded: [] } : {}),
    ...(Array.isArray(message.toolsRemoved) ? { toolsRemoved: [] } : {}),
    ...(message.sections && typeof message.sections === "object" && !Array.isArray(message.sections)
      && Object.values(message.sections).every(value => value === null || typeof value === "string") ? { sections: {} } : {}),
  };
}

function obsoleteCompactionDetails(details: any): any {
  const state = details?.compactionState;
  // pi-smart-compact's documented structured state is a superseded checkpoint,
  // not provider-native opaque state. Preserve every other detail/native field.
  const arrays = ["decisions", "constraints", "modifiedFiles", "readFiles", "deletedFiles", "unresolvedErrors", "resolvedErrors"];
  if (!details || typeof details.version !== "string" || !state || typeof state !== "object"
    || !(state.goal === null || typeof state.goal === "string")
    || !["decisions", "constraints", "modifiedFiles", "readFiles"].every(key => Array.isArray(state[key]))) return details;
  return { ...details, compactionState: { ...state,
    ...Object.fromEntries(arrays.filter(key => Array.isArray(state[key])).map(key => [key, []])),
  } };
}

// These are known prose-bearing fields, not a blanket exemption for tool arguments.
// All other argument keys and every tool-call envelope remain opaque/wire-stable.
const historicalArgumentFields: Record<string, string[]> = {
  read: ["path"], bash: ["command"], write: ["content"], edit: ["oldText", "newText"],
  ctx_execute: ["code"], ctx_execute_file: ["code"], subagent: ["prompt"], steer_subagent: ["message"], todo: ["description"],
};
function frozenExtractionCall(block: any): boolean {
  return block?.type === "toolCall" && block.name === "subagent" && typeof block.arguments?.prompt === "string"
    && block.arguments.prompt.includes("CODEFLARE_EXTRACTION_REQUEST=");
}
function sameHistoricalBlocks(before: any, after: any): boolean {
  // Unsupported metadata makes the entire block opaque. Only schema-shaped,
  // metadata-free payload blocks may be replaced or removed by semantic work.
  const mutablePayload = (block: any): boolean => {
    if (!block || typeof block !== "object" || Array.isArray(block)) return false;
    const keys = Object.keys(block);
    if (block.type === "text") return typeof block.text === "string"
      && (block.textSignature === undefined || typeof block.textSignature === "string")
      && keys.every(key => ["type", "text", "textSignature"].includes(key));
    if (block.type === "thinking") return typeof block.thinking === "string"
      && (block.thinkingSignature === undefined || typeof block.thinkingSignature === "string")
      && keys.every(key => ["type", "thinking", "thinkingSignature"].includes(key));
    if (block.type === "image") return typeof block.data === "string" && typeof block.mimeType === "string"
      && keys.every(key => ["type", "data", "mimeType"].includes(key));
    return false;
  };
  const opaque = (content: any) => Array.isArray(content) ? content.filter(block => !mutablePayload(block)) : [];
  const original = opaque(before), candidate = opaque(after);
  if (original.length !== candidate.length) return false;
  return original.every((block: any, i: number) => {
    const next = candidate[i], fields = block?.type === "toolCall" && !frozenExtractionCall(block) ? historicalArgumentFields[block.name] : undefined;
    if (!fields || !block.arguments || !next?.arguments || typeof block.arguments !== "object" || typeof next.arguments !== "object"
      || Array.isArray(block.arguments) || Array.isArray(next.arguments)) return isDeepStrictEqual(block, next);
    const args = { ...block.arguments };
    for (const field of fields) {
      if (!(field in args)) continue;
      if (typeof args[field] !== "string" || typeof next.arguments[field] !== "string") return false;
      args[field] = next.arguments[field];
    }
    if (block.name === "edit" && Array.isArray(block.arguments.edits) && Array.isArray(next.arguments.edits)
      && block.arguments.edits.length === next.arguments.edits.length) {
      args.edits = block.arguments.edits.map((edit: any, i: number) => {
        if (!edit || typeof edit !== "object" || Array.isArray(edit)) return edit;
        const expected = { ...edit }, candidate = next.arguments.edits[i];
        for (const key of ["oldText", "newText"]) if (typeof edit[key] === "string" && typeof candidate?.[key] === "string") expected[key] = candidate[key];
        return expected;
      });
    }
    return isDeepStrictEqual({ ...block, arguments: args }, next);
  });
}

/** Only known historical payload fields may differ. Everything else is opaque, including
 * message accounting, tool IDs, user text, and all unknown custom records. */
export function validateTranscriptTrimCandidate(source: string, candidate: string, sessionId: string, branchIds: string[] = []): void {
  const before = parseTranscript(source, sessionId, true), after = parseTranscript(candidate, sessionId, true);
  if (before.length !== after.length) throw new Error("changed-entry-count");
  const eligible = historicalEligibility(before, branchIds), obsoleteTasks = supersededTodoData(before, branchIds);
  const sourceLines = source.split("\n"), candidateLines = candidate.split("\n");
  for (let i = 0; i < before.length; i++) {
    const a = before[i], b = after[i];
    if (isDeepStrictEqual(a, b)) {
      if (sourceLines[i] !== candidateLines[i]) throw new Error(`changed-opaque-serialization:${a.id}`);
      continue;
    }
    if (!eligible.has(a.id) && obsoleteTasks.has(a.id)) {
      const tasks = todo(a) ? b.data?.tasks : b.message?.details?.tasks;
      const expected = todo(a) ? { ...a, data: { ...a.data, tasks } }
        : { ...a, message: { ...a.message, details: { ...a.message.details, tasks } } };
      if (Array.isArray(tasks) && tasks.length === 0 && isDeepStrictEqual(expected, b)) continue;
    }
    if (!eligible.has(a.id)) throw new Error(`protected-entry:${a.id}`);
    let expected = a;
    if (a.type === "custom" && stateTypes.has(a.customType)) {
      expected = { ...a, data: b.data };
    } else if (a.type === "compaction" && typeof b.summary === "string") {
      expected = { ...a, summary: b.summary,
        ...(a.systemMessage?.role === "system" && !isDeepStrictEqual(a.systemMessage, b.systemMessage)
          ? { systemMessage: obsoleteSystemPayload(a.systemMessage) } : {}),
        ...(!isDeepStrictEqual(a.details, b.details) ? { details: obsoleteCompactionDetails(a.details) } : {}),
      };
    } else if (a.type === "message" && ["assistant", "system", "toolResult"].includes(a.message?.role)) {
      const m = a.message, n = b.message;
      if (!n || !Array.isArray(n.content)) throw new Error(`invalid-message:${a.id}`);
      if (!sameHistoricalBlocks(m.content, n.content)) throw new Error(`changed-opaque-block:${a.id}`);
      expected = { ...a, message: m.role === "system"
        ? { ...obsoleteSystemPayload(m), content: n.content } : { ...m, content: n.content } };
      if (m.role === "toolResult" && m.toolName === "todo" && snapshot(m.details)) {
        // Only the recognized duplicate snapshot fields may change; any extension
        // fields remain opaque even when attached to a historical Todo result.
        const opaqueDetails = (details: any) => Object.fromEntries(Object.entries(details ?? {})
          .filter(([key]) => !["tasks", "nextId", "action"].includes(key)));
        if (!isDeepStrictEqual(opaqueDetails(m.details), opaqueDetails(n.details))) throw new Error(`changed-opaque-details:${a.id}`);
        expected.message = { ...expected.message, details: n.details };
        if (n.details === undefined) delete expected.message.details;
      }
    }
    if (!isDeepStrictEqual(expected, b)) throw new Error(`changed-envelope-or-opaque:${a.id}`);
  }
}

/** One local pass over authorized old payloads; nothing is sent to a model. */
// Keep original, permitted historical prose rather than overshooting the size
// goal by dropping a whole large block. Never pad or change protected content.
function retainHistoricalProse(entry: Entry, reduced: Entry, byteLimit: number): Entry {
  if (!Array.isArray(entry.message?.content) || !Array.isArray(reduced.message?.content)) return reduced;
  let result = reduced;
  for (const block of entry.message.content) {
    const key = block?.type === "text" ? "text" : block?.type === "thinking" ? "thinking" : undefined;
    if (!key || typeof block[key] !== "string" || !sameHistoricalBlocks([block], [])) continue;
    const original = block[key] as string;
    const withPrefix = (length: number) => ({ ...result, message: { ...result.message,
      content: [...result.message.content, { ...block, [key]: original.slice(0, length) }] } });
    let available = byteLimit - Buffer.byteLength(JSON.stringify(withPrefix(0))), length = 0;
    // Count JSON-escaped UTF-8 bytes once; never repeatedly serialize a huge
    // prefix or split a surrogate pair. These are original history bytes only.
    while (length < original.length) {
      const code = original.charCodeAt(length), next = original.charCodeAt(length + 1);
      const pair = code >= 0xd800 && code <= 0xdbff && next >= 0xdc00 && next <= 0xdfff;
      const bytes = pair ? 4 : code >= 0xd800 && code <= 0xdfff ? 6
        : code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2
        : code < 32 ? 6 : code < 128 ? 1 : code < 2048 ? 2 : 3;
      if (available < bytes) break;
      available -= bytes; length += pair ? 2 : 1;
    }
    if (length > 0) result = withPrefix(length);
    if (length < original.length) break;
  }
  return result;
}

export function prepareLocalTranscriptTrim(raw: string, sessionId: string, branchIds: string[], budget: number): { candidate: string; remainingBytes: number; withinTarget: boolean } {
  const entries = parseTranscript(raw, sessionId, true), eligible = historicalEligibility(entries, branchIds);
  const obsoleteTasks = supersededTodoData(entries, branchIds);
  const lines = raw.slice(0, -1).split("\n");
  let size = Buffer.byteLength(raw);
  const preferred = Math.min(TARGET, budget);
  let lastReduced = 0;
  for (let i = 1; i < entries.length && size > preferred; i++) {
    const entry = entries[i];
    if (!eligible.has(entry.id) && !obsoleteTasks.has(entry.id)) continue;
    let reduced = entry;
    if (todo(entry)) reduced = { ...entry, data: { ...entry.data, tasks: [] } };
    else if (entry.type === "custom" && stateTypes.has(entry.customType)) reduced = { ...entry, data: {} };
    else if (entry.type === "compaction") reduced = { ...entry, summary: "[Obsolete historical summary trimmed]",
      ...(entry.systemMessage?.role === "system" ? { systemMessage: obsoleteSystemPayload(entry.systemMessage) } : {}),
      ...(entry.details !== undefined ? { details: obsoleteCompactionDetails(entry.details) } : {}),
    };
    else if (entry.type === "message") {
      const message = entry.message;
      const content = eligible.has(entry.id) ? (Array.isArray(message.content) ? message.content : []).filter((block: any) => !sameHistoricalBlocks([block], [])).map((block: any) => {
        const fields = block?.type === "toolCall" && !frozenExtractionCall(block) ? historicalArgumentFields[block.name] : undefined;
        if (!fields || !block.arguments || typeof block.arguments !== "object" || Array.isArray(block.arguments)) return block;
        const args = { ...block.arguments };
        for (const key of fields) if (typeof args[key] === "string" && args[key].length > 64) args[key] = "[Obsolete historical payload trimmed]";
        if (block.name === "edit" && Array.isArray(args.edits)) args.edits = args.edits.map((edit: any) => {
          if (!edit || typeof edit !== "object" || Array.isArray(edit)) return edit;
          const reduced = { ...edit };
          for (const key of ["oldText", "newText"]) if (typeof reduced[key] === "string" && reduced[key].length > 64) reduced[key] = "[Obsolete historical payload trimmed]";
          return reduced;
        });
        return { ...block, arguments: args };
      }) : message.content;
      const next = eligible.has(entry.id) && message.role === "system"
        ? { ...obsoleteSystemPayload(message), content } : { ...message, content };
      if (message.role === "toolResult" && message.toolName === "todo" && snapshot(message.details)) next.details = { ...message.details, tasks: [] };
      reduced = { ...entry, message: next };
    }
    const line = JSON.stringify(reduced), savings = Buffer.byteLength(lines[i]) - Buffer.byteLength(line);
    if (savings > 0) { lines[i] = line; size -= savings; lastReduced = i; }
  }
  // A large obsolete non-prose snapshot can cross the goal in one removal.
  // Retain permitted original prose from reduced history rather than padding.
  for (let i = lastReduced; i > 0 && size < preferred; i--) {
    if (!eligible.has(entries[i].id) || entries[i].type !== "message") continue;
    const oldBytes = Buffer.byteLength(lines[i]);
    const retained = retainHistoricalProse(entries[i], JSON.parse(lines[i]), oldBytes + preferred - size);
    const line = JSON.stringify(retained), growth = Buffer.byteLength(line) - oldBytes;
    if (growth > 0) { lines[i] = line; size += growth; }
  }
  const candidate = lines.join("\n") + "\n";
  validateTranscriptTrimCandidate(raw, candidate, sessionId, branchIds);
  return { candidate, remainingBytes: size, withinTarget: size >= MINIMUM && size <= Math.min(MAXIMUM, budget) };
}

export function createTranscriptTrimRequest(ctx: TrimContext, feedback = "", retry = false): TranscriptTrimRequest | undefined {
  const owner = identity(ctx);
  if (!owner) throw new Error("missing-owner");
  const stamp = pathIdentity(owner.file, fs), stat = fs.lstatSync(owner.file);
  if (stat.uid !== process.getuid?.() || stat.nlink !== 1) throw new Error("foreign-ownership");
  if (stat.size <= (retry ? MAXIMUM : CAP)) return undefined;
  const bytes = fs.readFileSync(owner.file);
  const entries = parseTranscript(decode(bytes), owner.sessionId, true);
  const branch = ctx.sessionManager.getBranch(), branchIds = branch.map(e => e.id);
  const index = new Map(entries.slice(1).map(e => [e.id, e]));
  const leaf = ctx.sessionManager.getLeafId();
  const missing = branchIds.filter(id => !index.has(id));
  const edgeIndex = branchIds.findIndex((id, i) => i > 0 && index.has(id) && index.get(id)!.parentId !== branchIds[i - 1]);
  const cachedMismatch = branch.some((entry, i) => (i > 0 && entry.parentId !== branchIds[i - 1])
    || (index.has(entry.id) && (entry.parentId !== index.get(entry.id)!.parentId || entry.type !== index.get(entry.id)!.type)));
  const invalidBranch = !branchIds.length || branchIds.at(-1) !== leaf || !index.has(leaf)
    || new Set(branchIds).size !== branchIds.length || edgeIndex >= 0 || cachedMismatch
    || (branch[0]?.parentId != null && index.has(branch[0].parentId));
  const projection = invalidBranch ? undefined : activeHistory(entries, branchIds);
  const frontier = projection?.frontierId ? branchIds.indexOf(projection.frontierId) : -1;
  // A missing SDK segment is explained only by its unchanged persisted child gap,
  // coherent loaded ancestry, and a later valid current-context frontier.
  const unsafeMissing = missing.length > 0 && (frontier < 0 || branchIds.some((id, i) => !index.has(id) && i >= frontier));
  if (invalidBranch || unsafeMissing) {
    throw new Error(`foreign-branch:${JSON.stringify({ leaf, branchLast: branchIds.at(-1) ?? null,
      leafOnDisk: index.has(leaf), branchLastOnDisk: index.has(branchIds.at(-1)), missingCount: missing.length,
      missingSample: missing.slice(0, 8), cachedMismatch, unsafeMissing, edgeMismatch: edgeIndex < 0 ? null : {
        id: branchIds[edgeIndex], diskParent: index.get(branchIds[edgeIndex])!.parentId, branchParent: branchIds[edgeIndex - 1],
      } })}`);
  }
  const directory = fs.mkdtempSync(join(dirname(owner.file), ".transcript-trim-"));
  const request: TranscriptTrimRequest = { version: 1, requestId: randomUUID(), ...owner,
    sourceBytes: bytes.length, sourceSha256: digest(bytes), sourcePathIdentity: stamp, branchIds,
    targetBytes: TARGET, candidateBudget: MAXIMUM - COMPLETION_RESERVE, directory,
    directoryIdentity: `${fs.lstatSync(directory).dev}:${fs.lstatSync(directory).ino}`, varsFile: join(directory, "request.json"),
    candidateFile: join(directory, "candidate.jsonl"), feedback: feedback.slice(0, 2000) };
  try { fs.writeFileSync(request.varsFile, JSON.stringify(request), { flag: "wx", mode: 0o600 }); }
  catch (error) { cleanupRequest(request); throw error; }
  return request;
}
function ownedDirectory(request: TranscriptTrimRequest, io: typeof fs): boolean {
  const stat = io.lstatSync(request.directory);
  return stat.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid?.()
    && `${stat.dev}:${stat.ino}` === request.directoryIdentity;
}
function cleanupRequest(request: TranscriptTrimRequest, io: typeof fs = fs): boolean {
  // Only these exact parent-owned staging names; never traverse child-created paths.
  try {
    if (!ownedDirectory(request, io)) return false;
    for (const file of [request.candidateFile, request.varsFile]) {
      try { io.unlinkSync(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
    }
    io.rmdirSync(request.directory);
    return true;
  } catch (error) {
    // Already removed is success; substituted or inaccessible directories are not.
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/** Parent-owned synchronous commit. No await/cache mutation; all concurrent ordinary tail
 * appends are copied verbatim, and any changed prefix/branch/path refuses the candidate. */
export function commitTranscriptTrimCandidate(ctx: TrimContext, request: TranscriptTrimRequest, io: typeof fs = fs): TrimResult {
  let temp: string | undefined, committed = false, before: number | undefined, after: number | undefined;
  try {
    if (!same(identity(ctx), request)) throw new Error("session-changed");
    if (request.committed) {
      const receipt = request.committed;
      pathIdentity(request.file, io);
      const stat = io.lstatSync(request.file);
      if (stat.uid !== process.getuid?.() || stat.nlink !== 1) throw new Error("foreign-ownership");
      const persisted = io.readFileSync(request.file);
      if (persisted.length < MINIMUM || persisted.length > MAXIMUM || persisted.length < receipt.bytes
        || digest(persisted.subarray(0, receipt.bytes)) !== receipt.sha256) throw new Error("persisted-verification-failed");
      parseTranscript(decode(persisted), request.sessionId, true);
      if (!cleanupRequest(request, io)) throw new Error("staging-cleanup-pending");
      return { status: "trimmed", before: receipt.before, after: persisted.length,
        ...(receipt.warning ? { reason: receipt.warning } : {}) };
    }
    const branch = ctx.sessionManager.getBranch().map(e => e.id);
    if (request.branchIds.some((id, i) => branch[i] !== id)) throw new Error("branch-changed");
    if (pathIdentity(request.file, io) !== request.sourcePathIdentity) throw new Error("source-path-changed");
    const stat = io.lstatSync(request.file);
    if (stat.uid !== process.getuid?.() || stat.nlink !== 1) throw new Error("foreign-ownership");
    const current = io.readFileSync(request.file); before = current.length;
    const prefix = current.subarray(0, request.sourceBytes);
    if (digest(prefix) !== request.sourceSha256) throw new Error("source-prefix-changed");
    if (!ownedDirectory(request, io)) throw new Error("foreign-staging-directory");
    pathIdentity(request.candidateFile, io);
    const candidateStat = io.lstatSync(request.candidateFile);
    if (candidateStat.uid !== stat.uid || candidateStat.nlink !== 1) throw new Error("foreign-candidate");
    if (candidateStat.size > MAXIMUM) throw new Error(`candidate-exceeds-target:${candidateStat.size}`);
    const candidate = io.readFileSync(request.candidateFile);
    validateTranscriptTrimCandidate(decode(prefix), decode(candidate), request.sessionId, request.branchIds);
    const tail = current.subarray(request.sourceBytes);
    const final = Buffer.concat([candidate, tail]); after = final.length;
    if (after < MINIMUM) throw new Error(`total-below-minimum:${after}`);
    if (after > MAXIMUM - COMPLETION_RESERVE || after >= before) throw new Error(`total-exceeds-target:tail=${tail.length};candidate-budget=${MAXIMUM - COMPLETION_RESERVE - tail.length}`);
    // Validate the tail too: merging must not introduce links/IDs not present in source.
    validateTranscriptTrimCandidate(decode(current), decode(final), request.sessionId, branch);
    temp = join(dirname(request.file), `.transcript-trim-${randomUUID()}.tmp`);
    const fd = io.openSync(temp, "wx", 0o600);
    try { io.writeFileSync(fd, final); io.fchownSync(fd, stat.uid, stat.gid); io.fchmodSync(fd, stat.mode & 0o7777); io.fsyncSync(fd); }
    finally { io.closeSync(fd); }
    const dir = io.openSync(dirname(request.file), "r");
    let warning: string | undefined;
    try {
      if (!same(identity(ctx), request) || !isDeepStrictEqual(ctx.sessionManager.getBranch().map(e => e.id), branch)
        || pathIdentity(request.file, io) !== request.sourcePathIdentity
        || sourceIdentity(io.lstatSync(request.file)) !== sourceIdentity(stat)) throw new Error("source-or-session-changed");
      io.renameSync(temp, request.file); temp = undefined; committed = true;
      request.committed = { sha256: digest(final), bytes: final.length, before };
      try { io.fsyncSync(dir); } catch { warning = "directory-sync-failed"; request.committed.warning = warning; }
    } finally { io.closeSync(dir); }
    return commitTranscriptTrimCandidate(ctx, request, io);
  } catch (error) {
    return { status: request.committed ? "verification-pending" : "refused", before: request.committed?.before ?? before,
      after: request.committed?.bytes ?? after, reason: `${committed || request.committed ? "postcommit:" : ""}${error instanceof Error ? error.message : "io-failure"}` };
  } finally { if (temp) { try { io.unlinkSync(temp); } catch {} } }
}

/** One focused native tool: no shell, arbitrary read path, or live-write operation is
 * exposed to the maintenance agent. Scope comes from its public launch, not arguments. */
function registerTranscriptTrimTool(pi: ExtensionAPI, requestMaintenance: (ctx: TrimContext) => Record<string, unknown>): void {
  pi.registerTool?.({
    name: "transcript_trim",
    label: "Trim authorized old transcript payloads",
    description: "Parent request schedules the existing shared extraction launch; scoped child trim reduces its authorized prefix locally. Tool execution never writes live history.",
    // Pi's public validator also accepts JSON Schema without TypeBox symbols.
    parameters: {
      type: "object", properties: { operation: { type: "string", enum: ["request", "trim", "contract"] } },
      required: ["operation"], additionalProperties: false,
    } as any,
    async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
      const ownerContext = ctx as unknown as TrimContext;
      if (params.operation === "request") {
        const result = requestMaintenance(ownerContext);
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      }
      const userText = ownerContext.sessionManager.getBranch().filter((e: any) => e.type === "message" && e.message?.role === "user")
        .map((e: any) => typeof e.message.content === "string" ? e.message.content : e.message.content?.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n"))
        .slice().reverse().find((text: string) => /^CODEFLARE_EXTRACTION_REQUEST=[0-9a-f-]+$/m.test(text ?? ""));
      const varsFile = userText?.match(/^VARS_FILE=(.+)$/m)?.[1];
      const requestId = userText?.match(/^CODEFLARE_EXTRACTION_REQUEST=([0-9a-f-]+)$/m)?.[1];
      if (!varsFile || !isAbsolute(varsFile)) throw new Error("missing-maintenance-launch-scope");
      pathIdentity(varsFile, fs);
      const request = JSON.parse(fs.readFileSync(varsFile, "utf8")) as TranscriptTrimRequest;
      const directory = dirname(varsFile);
      if (request.version !== 1 || request.requestId !== requestId || request.varsFile !== varsFile
        || request.directory !== directory || request.candidateFile !== join(directory, "candidate.jsonl")
        || !directory.startsWith(join(dirname(request.file), ".transcript-trim-"))
        || !ownedDirectory(request, fs) || !Number.isSafeInteger(request.sourceBytes) || request.sourceBytes < 1
        || !/^[0-9a-f]{64}$/.test(request.sourceSha256)) throw new Error("invalid-maintenance-launch-scope");
      pathIdentity(request.file, fs);
      const fd = fs.openSync(request.file, "r");
      const source = Buffer.alloc(request.sourceBytes);
      try {
        let offset = 0;
        while (offset < source.length) {
          const count = fs.readSync(fd, source, offset, source.length - offset, offset);
          if (!count) throw new Error("source-prefix-short");
          offset += count;
        }
      } finally { fs.closeSync(fd); }
      if (digest(source) !== request.sourceSha256) throw new Error("source-prefix-changed");
      const raw = decode(source);
      parseTranscript(raw, request.sessionId, true);
      let result: unknown;
      if (params.operation === "contract") {
        const { branchIds, ...summary } = request;
        result = { request: { ...summary, branchEntryCount: branchIds.length },
          contract: "Call operation trim once. It locally validates and reduces only this authorized prefix; report its compact result. Only the owning parent can verify and commit." };
      } else if (params.operation === "trim") {
        const tailBytes = Math.max(0, fs.statSync(request.file).size - request.sourceBytes);
        const budget = Math.max(0, request.candidateBudget - tailBytes);
        const trimmed = prepareLocalTranscriptTrim(raw, request.sessionId, request.branchIds, budget);
        const projectedTotalBytes = trimmed.remainingBytes + tailBytes;
        const accepted = projectedTotalBytes >= MINIMUM && projectedTotalBytes <= MAXIMUM - COMPLETION_RESERVE
          && trimmed.remainingBytes <= budget;
        if (accepted) {
          if (!ownedDirectory(request, fs)) throw new Error("foreign-staging-directory");
          const fd = fs.openSync(request.candidateFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
          try {
            const stat = fs.fstatSync(fd);
            if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.()) throw new Error("foreign-candidate");
            fs.ftruncateSync(fd, 0); fs.writeFileSync(fd, trimmed.candidate);
          } finally { fs.closeSync(fd); }
        }
        result = { requestId, candidateBytes: accepted ? trimmed.remainingBytes : null,
          remainingBytes: trimmed.remainingBytes, projectedTotalBytes, budgetBytes: budget,
          minimumBytes: MINIMUM, targetBytes: TARGET, maximumBytes: MAXIMUM, withinTarget: accepted, committed: false };
      } else throw new Error("unknown-maintenance-operation");
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: { committed: false } };
    },
  });
}

function candidateWithinWindow(request: TranscriptTrimRequest, io: typeof fs): boolean {
  try {
    if (!ownedDirectory(request, io)) return false;
    const candidate = io.lstatSync(request.candidateFile);
    if (!candidate.isFile() || candidate.isSymbolicLink() || candidate.nlink !== 1 || candidate.uid !== process.getuid?.()) return false;
    const tail = Math.max(0, io.lstatSync(request.file).size - request.sourceBytes);
    const total = candidate.size + tail;
    return total >= MINIMUM && total <= MAXIMUM - COMPLETION_RESERVE;
  } catch { return false; }
}

export function registerActiveSessionTranscriptTrimming(pi: ExtensionAPI, io: typeof fs = fs) {
  let due: Identity | undefined, request: TranscriptTrimRequest | undefined;
  const receipts = new Map<string, TranscriptTrimRequest>();
  registerTranscriptTrimTool(pi, ctx => {
    const owner = identity(ctx), header = ctx.sessionManager.getHeader?.();
    if (!owner || !header || header.id !== owner.sessionId || header.parentSession) throw new Error("parent-owner-required");
    if (due || request || [...receipts.values()].some(receipt => same(owner, receipt))) return { status: "already-pending", committed: false };
    due = owner;
    return { status: "scheduled", committed: false };
  });
  const cancel = () => {
    // Release scheduling ownership, but retain committed work for read-only
    // verification when its own session is loaded again. Never replay a write.
    if (request?.committed) receipts.set(request.requestId, request);
    else if (request) cleanupRequest(request);
    request = undefined; due = undefined;
  };
  const outcome = (value: TrimResult) => {
    pi.sendMessage({ customType: "transcript-trim-outcome", display: true,
      content: value.status === "trimmed"
        ? `Transcript maintenance verified: ${value.before} → ${value.after} bytes (target ${TARGET}; accepted ${MINIMUM}–${MAXIMUM}).`
        : `Transcript maintenance not completed: ${value.reason}. Source was not reported as successfully trimmed.`,
      details: value }, { triggerTurn: false });
  };
  return {
    cancel,
    markDue(ctx: TrimContext) {
      const owner = identity(ctx);
      if (owner && !request && ![...receipts.values()].some(receipt => same(owner, receipt))) due = owner;
    },
    collect(ctx: TrimContext & { signal?: AbortSignal }): Record<string, unknown> | undefined {
      if (ctx.signal?.aborted) { cancel(); return; }
      for (const receipt of receipts.values()) {
        if (!same(identity(ctx), receipt)) continue;
        const result = commitTranscriptTrimCandidate(ctx, receipt, io);
        if (result.status === "trimmed") receipts.delete(receipt.requestId);
        outcome(result);
        if (result.status !== "trimmed") return;
      }
      if (!due || !same(identity(ctx), due)) return;
      try {
        if (request?.committed) {
          const result = commitTranscriptTrimCandidate(ctx, request, io);
          if (result.status === "trimmed") { request = undefined; due = undefined; }
          outcome(result); return;
        }
        if (!request) request = createTranscriptTrimRequest(ctx);
        if (!request) { due = undefined; return; }
        const entries = parseTranscript(decode(fs.readFileSync(request.file)), request.sessionId, true);
        let facts = extractionTranscriptFacts({ entries, requestId: request.requestId, job: "transcript-trim", now: Date.now(),
          successQualifies: attempt => !!attempt?.latest && candidateWithinWindow(request!, io) });
        if (facts.stopped) { cancel(); return; }
        if (facts.state === "succeeded") {
          const result = commitTranscriptTrimCandidate(ctx, request, io);
          if (result.status === "refused" && ["source-prefix-changed", "branch-changed", "source-path-changed"].includes(result.reason ?? "")) {
            cleanupRequest(request);
            request = createTranscriptTrimRequest(ctx, result.reason, true);
            if (!request) { due = undefined; return; }
            return { requestId: request.requestId, jobType: "transcript-trim", reminder: 0,
              request: buildPublicTranscriptTrimRequest({ requestId: request.requestId,
                promptFile: "/home/user/.pi/agent/prompts/transcript-trim-agent-prompt.md", varsFile: request.varsFile }) };
          }
          if (result.status === "trimmed" || result.status === "verification-pending") {
            if (result.status === "trimmed") { request = undefined; due = undefined; }
            outcome(result); return;
          }
          // A completed child with an inadmissible candidate is a failed exact
          // attempt, not successful maintenance. Reuse the common delivery budget.
          outcome(result);
          facts = extractionTranscriptFacts({ entries, requestId: request.requestId, job: "transcript-trim", now: Date.now(), successQualifies: () => false });
        }
        const next = extractionDue(facts);
        if (next.kind === "giveup") {
          const requestId = request.requestId; cancel();
          return { requestId, jobType: "transcript-trim", giveup: true };
        }
        if (next.kind !== "launch") return;
        // A retry must produce its own candidate, never inherit a prior attempt's staging.
        if (next.reminder > 0) {
          if (!ownedDirectory(request, io)) throw new Error("foreign-staging-directory");
          try { io.unlinkSync(request.candidateFile); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
        return { requestId: request.requestId, jobType: "transcript-trim", reminder: next.reminder,
          request: buildPublicTranscriptTrimRequest({ requestId: request.requestId,
            promptFile: "/home/user/.pi/agent/prompts/transcript-trim-agent-prompt.md", varsFile: request.varsFile }) };
      } catch (error) {
        if (!request?.committed) cancel();
        outcome({ status: request?.committed ? "verification-pending" : "refused", reason: error instanceof Error ? error.message : "request-io-failure" });
      }
    },
  };
}

// memory-vault owns registration, cadence, delivery and boundary advancement.
export default function (): void {}
