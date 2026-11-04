/** File-only retention. No SessionManager/cache mutation; ordinary SDK appends reopen this pathname. */
import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { isDeepStrictEqual, TextDecoder } from "node:util";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { buildPublicTranscriptTrimRequest, extractionTranscriptFacts, extractionDue, transcriptTrimLaunchNeedsRecovery } from "./memory-vault-helpers.ts";

export const TRANSCRIPT_TRIM_DUE = "codeflare:transcript-trim-due";
const CAP = 50_000_000;
const TARGET = 20_000_000;
// Leave room for the bounded parent-verified outcome entry itself.
const COMPLETION_RESERVE = 4096;
type Entry = Record<string, any>;
type Identity = { sessionId: string; file: string };
type TrimContext = Pick<ExtensionContext, "sessionManager">;
export type TrimResult = { status: "trimmed" | "unchanged" | "refused" | "verification-pending"; before?: number; after?: number; reason?: string };

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
    const compactAt = ids.findLastIndex(id => entries[byId.get(id)!].type === "compaction");
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
function historicalEligibility(entries: Entry[], activeLeaf?: string): Set<string> {
  const index = new Map(entries.slice(1).map((e, i) => [e.id, i + 1]));
  const leaf = activeLeaf ?? entries.at(-1)?.id;
  if (leaf && !index.has(leaf) && entries.length > 1) throw new Error("foreign-active-leaf");
  const active: number[] = [];
  for (let i = index.get(leaf); i; i = index.get(entries[i].parentId)) active.push(i);
  active.reverse();
  const compactAt = active.findLastIndex(i => entries[i].type === "compaction");
  const firstKept = compactAt >= 0 ? active.findIndex(i => entries[i].id === entries[active[compactAt]].firstKeptEntryId) : -1;
  // An absent or non-ancestral frontier cannot authorize reducing current context.
  const start = firstKept >= 0 && firstKept <= compactAt ? firstKept : 0;
  const keep = new Set(active.slice(start));
  for (const type of stateTypes) {
    const global = entries.findLastIndex(e => e.type === "custom" && e.customType === type);
    const onBranch = active.findLast(i => entries[i].type === "custom" && entries[i].customType === type);
    if (global > 0) keep.add(global);
    if (onBranch !== undefined) keep.add(onBranch);
  }
  return new Set(entries.slice(1).filter((entry, i) => !keep.has(i + 1)
    && ((entry.type === "custom" && stateTypes.has(entry.customType)) || entry.type === "compaction"
      || (entry.type === "message" && ["assistant", "system", "toolResult"].includes(entry.message?.role)))).map(e => e.id));
}

// These are known prose-bearing fields, not a blanket exemption for tool arguments.
// All other argument keys and every tool-call envelope remain opaque/wire-stable.
const historicalArgumentFields: Record<string, string[]> = {
  read: ["path"], bash: ["command"], write: ["content"], edit: ["oldText", "newText"],
};
function sameHistoricalBlocks(before: any, after: any): boolean {
  // Unsupported metadata makes the entire block opaque. Only schema-shaped,
  // metadata-free payload blocks may be replaced or removed by semantic work.
  const mutablePayload = (block: any): boolean => {
    if (!block || typeof block !== "object" || Array.isArray(block)) return false;
    const keys = Object.keys(block);
    if (block.type === "text") return typeof block.text === "string" && keys.every(key => ["type", "text"].includes(key));
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
    const next = candidate[i], fields = block?.type === "toolCall" ? historicalArgumentFields[block.name] : undefined;
    if (!fields || !block.arguments || !next?.arguments || typeof block.arguments !== "object" || typeof next.arguments !== "object"
      || Array.isArray(block.arguments) || Array.isArray(next.arguments)) return isDeepStrictEqual(block, next);
    const args = { ...block.arguments };
    for (const field of fields) {
      if (!(field in args)) continue;
      if (typeof args[field] !== "string" || typeof next.arguments[field] !== "string") return false;
      args[field] = next.arguments[field];
    }
    return isDeepStrictEqual({ ...block, arguments: args }, next);
  });
}

/** Only known historical payload fields may differ. Everything else is opaque, including
 * message accounting, tool IDs, user text, and all unknown custom records. */
export function validateTranscriptTrimCandidate(source: string, candidate: string, sessionId: string, branchIds: string[] = []): void {
  const before = parseTranscript(source, sessionId, true), after = parseTranscript(candidate, sessionId, true);
  if (before.length !== after.length) throw new Error("changed-entry-count");
  const eligible = historicalEligibility(before, branchIds.at(-1));
  const sourceLines = source.split("\n"), candidateLines = candidate.split("\n");
  for (let i = 0; i < before.length; i++) {
    const a = before[i], b = after[i];
    if (isDeepStrictEqual(a, b)) {
      if (sourceLines[i] !== candidateLines[i]) throw new Error(`changed-opaque-serialization:${a.id}`);
      continue;
    }
    if (!eligible.has(a.id)) throw new Error(`protected-entry:${a.id}`);
    let expected = a;
    if (a.type === "custom" && stateTypes.has(a.customType)) {
      expected = { ...a, data: b.data };
    } else if (a.type === "compaction" && typeof b.summary === "string") {
      expected = { ...a, summary: b.summary };
    } else if (a.type === "message" && ["assistant", "system", "toolResult"].includes(a.message?.role)) {
      const m = a.message, n = b.message;
      if (!n || !Array.isArray(n.content)) throw new Error(`invalid-message:${a.id}`);
      if (!sameHistoricalBlocks(m.content, n.content)) throw new Error(`changed-opaque-block:${a.id}`);
      expected = { ...a, message: { ...m, content: n.content } };
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

export function createTranscriptTrimRequest(ctx: TrimContext, feedback = "", retry = false): TranscriptTrimRequest | undefined {
  const owner = identity(ctx);
  if (!owner) throw new Error("missing-owner");
  const stamp = pathIdentity(owner.file, fs), stat = fs.lstatSync(owner.file);
  if (stat.uid !== process.getuid?.() || stat.nlink !== 1) throw new Error("foreign-ownership");
  if (stat.size <= (retry ? TARGET : CAP)) return undefined;
  const bytes = fs.readFileSync(owner.file);
  const entries = parseTranscript(decode(bytes), owner.sessionId, true);
  const branchIds = ctx.sessionManager.getBranch().map(e => e.id);
  const index = new Map(entries.slice(1).map(e => [e.id, e]));
  if (!branchIds.length || branchIds.at(-1) !== ctx.sessionManager.getLeafId()
    || branchIds.some((id, i) => !index.has(id) || (i > 0 && index.get(id)!.parentId !== branchIds[i - 1]))) throw new Error("foreign-branch");
  const directory = fs.mkdtempSync(join(dirname(owner.file), ".transcript-trim-"));
  const request: TranscriptTrimRequest = { version: 1, requestId: randomUUID(), ...owner,
    sourceBytes: bytes.length, sourceSha256: digest(bytes), sourcePathIdentity: stamp, branchIds,
    targetBytes: TARGET, candidateBudget: TARGET - COMPLETION_RESERVE, directory,
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
      if (persisted.length > TARGET || persisted.length < receipt.bytes
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
    if (candidateStat.size > TARGET) throw new Error(`candidate-exceeds-target:${candidateStat.size}`);
    const candidate = io.readFileSync(request.candidateFile);
    validateTranscriptTrimCandidate(decode(prefix), decode(candidate), request.sessionId, request.branchIds);
    const tail = current.subarray(request.sourceBytes);
    const final = Buffer.concat([candidate, tail]); after = final.length;
    if (after > TARGET - COMPLETION_RESERVE || after >= before) throw new Error(`total-exceeds-target:tail=${tail.length};candidate-budget=${TARGET - COMPLETION_RESERVE - tail.length}`);
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

function readWorkingCandidate(request: TranscriptTrimRequest): Buffer | undefined {
  if (!ownedDirectory(request, fs)) throw new Error("foreign-staging-directory");
  try { fs.lstatSync(request.candidateFile); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const fd = fs.openSync(request.candidateFile, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.() || stat.size > request.sourceBytes) throw new Error("foreign-candidate");
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}

/** One focused native tool: no shell, arbitrary read path, or live-write operation is
 * exposed to the maintenance agent. Scope comes from its public launch, not arguments. */
function registerTranscriptTrimTool(pi: ExtensionAPI): void {
  pi.registerTool?.({
    name: "transcript_trim",
    label: "Inspect / propose transcript maintenance",
    description: "Read the authorized maintenance contract or source prefix, or write an explicitly chosen semantic candidate. Never writes the live transcript.",
    // Pi's public validator also accepts JSON Schema without TypeBox symbols.
    parameters: {
      type: "object", properties: {
        operation: { type: "string", enum: ["contract", "inspect", "candidate"] },
        index: { type: "integer", minimum: 0 }, offset: { type: "integer", minimum: 0 },
        replacements: { type: "array", items: { type: "object", properties: {
          id: { type: "string" }, patch: { type: "string", description: "JSON object with explicitly chosen historical content/data/summary replacements only" },
        }, required: ["id", "patch"], additionalProperties: false } },
      }, required: ["operation"], additionalProperties: false,
    } as any,
    async execute(_toolCallId, params: any, _signal, _onUpdate, ctx) {
      const userText = ctx.sessionManager.getBranch().filter((e: any) => e.type === "message" && e.message?.role === "user")
        .map((e: any) => typeof e.message.content === "string" ? e.message.content : e.message.content?.filter((b: any) => b.type === "text").map((b: any) => b.text).join("\n"))
        .findLast((text: string) => /^CODEFLARE_EXTRACTION_REQUEST=[0-9a-f-]+$/m.test(text ?? ""));
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
      const raw = decode(source), entries = parseTranscript(raw, request.sessionId, true);
      const working = params.operation === "contract" ? undefined : readWorkingCandidate(request);
      const baseline = working ? decode(working) : raw;
      if (working) validateTranscriptTrimCandidate(raw, baseline, request.sessionId, request.branchIds);
      const workingEntries = working ? parseTranscript(baseline, request.sessionId, true) : entries;
      let result: unknown;
      if (params.operation === "contract") {
        result = { request, contract: fs.readFileSync("/home/user/.pi/agent/prompts/transcript-trim-agent-prompt.md", "utf8") };
      } else if (params.operation === "inspect") {
        if (params.index === undefined) {
          const offset = params.offset ?? 0, eligible = historicalEligibility(entries, request.branchIds.at(-1));
          const sizes = workingEntries.map((e, index) => ({ index, id: e.id, parentId: e.parentId,
            type: e.type, customType: e.customType, role: e.message?.role, bytes: Buffer.byteLength(JSON.stringify(e)), eligible: eligible.has(e.id) }));
          const categories: Record<string, number> = {};
          for (const row of sizes) {
            const category = row.type === "message" ? `message:${["user", "assistant", "system", "toolResult"].includes(row.role) ? row.role : "opaque"}`
              : row.type === "custom" && stateTypes.has(row.customType) ? row.customType : row.type === "compaction" ? "compaction" : "opaque";
            categories[category] = (categories[category] ?? 0) + row.bytes + 1;
          }
          const candidateBytes = working?.length ?? null;
          result = { request, entryCount: entries.length, candidateBytes,
            remainingBudget: request.candidateBudget - (candidateBytes ?? source.length),
            bytesToReduce: Math.max(0, (candidateBytes ?? source.length) - request.candidateBudget), categories,
            largestEligible: sizes.filter(e => e.eligible).sort((a, b) => b.bytes - a.bytes).slice(0, 20),
            nextOffset: offset + 100 < entries.length ? offset + 100 : null, entries: sizes.slice(offset, offset + 100) };
        } else {
          const row = workingEntries[params.index];
          if (!row) throw new Error("unknown-entry-index");
          const text = JSON.stringify(row), offset = params.offset ?? 0;
          result = { index: params.index, id: row.id, offset, totalCharacters: text.length, text: text.slice(offset, offset + 20000),
            nextOffset: offset + 20000 < text.length ? offset + 20000 : null };
        }
      } else if (params.operation === "candidate") {
        if (!params.replacements?.length) throw new Error("empty-candidate-batch");
        const replacements = new Map<string, Entry>();
        for (const replacement of params.replacements) {
          if (replacements.has(replacement.id)) throw new Error("duplicate-replacement");
          const patch = JSON.parse(replacement.patch);
          if (!patch || typeof patch !== "object" || Array.isArray(patch)) throw new Error("invalid-patch");
          replacements.set(replacement.id, patch);
        }
        const lines = baseline.slice(0, -1).split("\n");
        const candidate = workingEntries.map((entry, index) => {
          const patch = replacements.get(entry.id);
          if (!patch) return lines[index] + "\n";
          replacements.delete(entry.id);
          return encode({ ...entry, ...patch });
        }).join("");
        if (replacements.size) throw new Error("unknown-replacement-id");
        if (candidate === baseline || Buffer.byteLength(candidate) >= source.length) throw new Error("no-change-or-no-reduction");
        validateTranscriptTrimCandidate(raw, candidate, request.sessionId, request.branchIds);
        if (!ownedDirectory(request, fs)) throw new Error("foreign-staging-directory");
        const out = fs.openSync(request.candidateFile, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
        try {
          const stat = fs.fstatSync(out);
          if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid?.()) throw new Error("foreign-candidate");
          fs.ftruncateSync(out, 0);
          fs.writeFileSync(out, candidate);
        } finally { fs.closeSync(out); }
        result = { requestId, candidateBytes: Buffer.byteLength(candidate), targetBytes: TARGET,
          withinTarget: Buffer.byteLength(candidate) <= request.candidateBudget, committed: false };
      } else throw new Error("unknown-maintenance-operation");
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: { committed: false } };
    },
  });
}

export function registerActiveSessionTranscriptTrimming(pi: ExtensionAPI, io: typeof fs = fs): void {
  registerTranscriptTrimTool(pi);
  let current: TrimContext | undefined, due: Identity | undefined, request: TranscriptTrimRequest | undefined;
  let failures = 0;
  const cancel = () => { if (request) cleanupRequest(request); request = undefined; due = undefined; current = undefined; failures = 0; };
  pi.on("session_start", (_event, ctx) => { cancel(); current = ctx; });
  pi.on("session_before_switch", cancel);
  pi.on("session_before_fork", cancel);
  pi.on("session_shutdown", cancel);
  pi.events.on(TRANSCRIPT_TRIM_DUE, data => {
    const owner = data as Identity | undefined;
    if (owner && current && same(identity(current), owner) && (!request || request.committed)) { due = owner; failures = 0; }
  });
  const outcome = (value: TrimResult) => {
    const result = { ...value, ...(value.reason ? { reason: value.reason.slice(0, 2000) } : {}) };
    pi.sendMessage({ customType: "transcript-trim-outcome", display: true,
    content: result.status === "trimmed"
      ? `Transcript maintenance verified: ${result.before} → ${result.after} bytes (target ${TARGET}).${result.reason ? ` Durability warning: ${result.reason}.` : ""}`
      : `Transcript maintenance not completed: ${result.reason}. Source was not reported as successfully trimmed.`,
    details: result }, { triggerTurn: false });
  };
  const retryVerification = (result: TrimResult) => {
    failures++;
    outcome(result);
    if (failures >= 6) { due = undefined; return; }
    pi.sendMessage({ customType: "transcript-trim-retry", display: true,
      content: "Transcript replacement committed; retrying read-only verification. No replacement will be replayed.",
    }, { deliverAs: "followUp", triggerTurn: true });
  };
  const advance = (ctx: ExtensionContext) => {
    if (ctx.signal?.aborted || !current || !due || !same(identity(ctx), due)) return;
    let feedback = "";
    try {
      if (request?.committed) {
        const result = commitTranscriptTrimCandidate(ctx, request, io);
        if (result.status === "trimmed") { request = undefined; due = undefined; failures = 0; outcome(result); }
        else retryVerification(result);
        return;
      }
      if (request) {
        const entries = parseTranscript(decode(fs.readFileSync(request.file)), request.sessionId, true);
        const facts = extractionTranscriptFacts({ entries, requestId: request.requestId, job: "transcript-trim", now: Date.now(), successQualifies: () => true });
        // A follow-up queued at turn_end may not have entered the transcript yet.
        // Retain this request rather than mistaking deferred delivery for failure.
        if (facts.launchCount === 0) return;
        if (facts.state === "succeeded") {
          const result = commitTranscriptTrimCandidate(ctx, request, io);
          if (result.status === "trimmed") { request = undefined; due = undefined; failures = 0; outcome(result); return; }
          if (result.status === "verification-pending") { retryVerification(result); return; }
          feedback = result.reason ?? "candidate-rejected";
        } else {
          const next = extractionDue(facts);
          if (next.kind === "none") {
            if (!facts.pendingLaunch || !transcriptTrimLaunchNeedsRecovery(entries, request.requestId, Date.now())) return;
            feedback = "delivered-launch-missing-or-altered: submit the public native request unchanged";
          } else feedback = "native-call-failed-or-expired: recompute candidate and complete the native call";
        }
        cleanupRequest(request); request = undefined; failures++;
        if (failures >= 6) { due = undefined; outcome({ status: "refused", reason: `retry-limit:${feedback}` }); return; }
      }
      request = createTranscriptTrimRequest(ctx, feedback, failures > 0);
      if (!request) {
        due = undefined;
        if (feedback) outcome({ status: "refused", reason: feedback });
        return;
      }
      const item = { requestId: request.requestId, jobType: "transcript-trim", reminder: 0,
        request: buildPublicTranscriptTrimRequest({ requestId: request.requestId,
          promptFile: "/home/user/.pi/agent/prompts/transcript-trim-agent-prompt.md", varsFile: request.varsFile }) };
      const registered = pi.getAllTools?.().some(tool => tool.name === "subagent");
      if (registered) pi.setActiveTools([...new Set([...pi.getActiveTools(), "subagent"])]);
      pi.sendMessage({ customType: "background-extraction-launch", display: true,
        content: ["## Transcript maintenance ready", "Start this public background subagent request unchanged exactly once. Only the parent may commit the result.",
          "<extraction-items-json>", JSON.stringify([item], null, 2), "</extraction-items-json>"].join("\n"), details: { items: [item] } },
        { deliverAs: "followUp", triggerTurn: true });
    } catch (error) {
      if (request) cleanupRequest(request);
      request = undefined;
      // A subsequent ordinary settled boundary retries metadata/IO failures without claiming completion.
      failures++;
      outcome({ status: "refused", reason: error instanceof Error ? error.message : "request-io-failure" });
      if (failures >= 6) due = undefined;
      else pi.sendMessage({ customType: "transcript-trim-retry", display: true,
        content: "Transcript maintenance request preparation failed; retrying at the next settled boundary.",
      }, { deliverAs: "followUp", triggerTurn: true });
    }
  };
  // Pi persists this assistant (and tool results) before the turn_end boundary.
  // Follow-up delivery queues on the running agent, so queued work need not settle.
  pi.on("turn_end", (event, ctx) => {
    const message = event.message;
    if (event.outcome === "aborted" || message.role !== "assistant" || message.stopReason !== "stop"
      || message.content.some(block => block.type === "toolCall")) return;
    advance(ctx);
  });
  pi.on("agent_settled", (event, ctx) => { if (!event.aborted) advance(ctx); });
}

export default function (pi: ExtensionAPI): void { registerActiveSessionTranscriptTrimming(pi); }
