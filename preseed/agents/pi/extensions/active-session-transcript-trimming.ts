/** File-only retention. No SessionManager/cache mutation; ordinary SDK appends reopen this pathname. */
import * as fs from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, isAbsolute, join, parse, resolve } from "node:path";
import { isDeepStrictEqual, TextDecoder } from "node:util";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {parseTranscript,prepareTranscript,activeHistory,validateTranscriptTrimCandidate,prepareLocalTranscriptTrim,runTrimWorker,trimSourceIdentity} from "./transcript-trim/engine.mjs";
export {parseTranscript,prepareTranscript,validateTranscriptTrimCandidate,prepareLocalTranscriptTrim};

import { buildPublicTranscriptTrimRequest, extractionTranscriptFacts, extractionDue } from "./memory-vault-helpers";

const CAP = 50_000_000;
const MINIMUM = 15_000_000;
const TARGET = 20_000_000;
const MAXIMUM = 25_000_000;
type Entry = Record<string, any>;
type Identity = { sessionId: string; file: string };
type TrimContext = { sessionManager: {
  getSessionId(): string;
  getSessionFile(): string | undefined;
  getLeafId(): string | null;
  getBranch(): readonly Entry[];
  getEntries?(): readonly Entry[];
  getHeader?(): { id: string; parentSession?: string } | null;
} };
export type TrimResult = { status: "trimmed" | "unchanged" | "refused" | "verification-pending"; before?: number; after?: number; currentBytes?: number; appendedAfterCommitBytes?: number; reason?: string };

function identity(ctx: TrimContext): Identity | undefined {
  const sessionId = ctx.sessionManager.getSessionId?.();
  const file = ctx.sessionManager.getSessionFile?.();
  return sessionId && file && isAbsolute(file) ? { sessionId, file } : undefined;
}
function same(a: Identity | undefined, b: Identity | undefined): boolean {
  return !!a && !!b && a.sessionId === b.sessionId && a.file === b.file;
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
  attemptOffset?: number;
  committed?: { sha256: string; bytes: number; before: number; warning?: string };
}
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const decode = (bytes: Buffer) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);


// SDK subagents run in this Node process. Independent extension evaluations share
// only this revocable capability; no child process may replace live history.
type TrimActivation = { request: TranscriptTrimRequest;
  activateAsync(signal?: AbortSignal): Promise<TrimResult>; valid(): boolean; signal: AbortSignal; controller?: AbortController;
  busy?: boolean; preparations?: number; feedback?: any; selection?: string[] };

const activationKey = Symbol.for("codeflare.transcript-trim.activation.v2");
const activationHost = globalThis as any;
const trimActivations: Map<string, TrimActivation> = activationHost[activationKey] ??= new Map();

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
    targetBytes: TARGET, candidateBudget: MAXIMUM, directory,
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
    for (const file of [request.candidateFile, request.varsFile, join(request.directory, "activation.jsonl")]) {
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

/** Owner-runtime synchronous activation. No await/cache mutation; all concurrent ordinary tail
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
      if (receipt.bytes < MINIMUM || receipt.bytes > MAXIMUM || persisted.length < receipt.bytes
        || digest(persisted.subarray(0, receipt.bytes)) !== receipt.sha256) throw new Error("persisted-verification-failed");
      parseTranscript(decode(persisted), request.sessionId, true);
      if (!cleanupRequest(request, io)) throw new Error("staging-cleanup-pending");
      return { status: "trimmed", before: receipt.before, after: receipt.bytes,
        currentBytes:persisted.length,appendedAfterCommitBytes:persisted.length-receipt.bytes,
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
    if (after > MAXIMUM || after >= before) throw new Error(`total-exceeds-target:tail=${tail.length};candidate-budget=${MAXIMUM - tail.length}`);
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

/** One scoped native operation activates only through its live, revocable owner
 * capability. No shell, arbitrary path, or independent-process writer is exposed. */
function registerTranscriptTrimTool(pi: ExtensionAPI, requestMaintenance: (ctx: TrimContext) => Record<string, unknown>): void {
  pi.registerTool?.({
    name: "transcript_trim",
    label: "Trim authorized old transcript payloads",
    description: "Request schedules shared maintenance. The scoped agent trims, atomically activates and verifies its authorized transcript before returning; no parent handover or turn-end gate.",
    // Pi's public validator also accepts JSON Schema without TypeBox symbols.
    parameters: {
      type: "object", properties: { categories: {type:"array",items:{type:"string",enum:["historical-notification-results","historical-execution-inputs"]},maxItems:2,uniqueItems:true}, operation: { type: "string", enum: ["request", "trim", "contract", "prepare", "inspect", "refine", "activate"] } },
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
      if (_signal?.aborted) throw new Error("maintenance-canceled");
      if (!varsFile || !isAbsolute(varsFile)) throw new Error("missing-maintenance-launch-scope");
      pathIdentity(varsFile, fs);
      const request = JSON.parse(fs.readFileSync(varsFile, "utf8")) as TranscriptTrimRequest;
      const directory = dirname(varsFile);
      if (request.version !== 1 || request.requestId !== requestId || request.varsFile !== varsFile
        || request.directory !== directory || request.candidateFile !== join(directory, "candidate.jsonl")
        || !directory.startsWith(join(dirname(request.file), ".transcript-trim-"))
        || !ownedDirectory(request, fs) || !Number.isSafeInteger(request.sourceBytes) || request.sourceBytes < 1
        || !/^[0-9a-f]{64}$/.test(request.sourceSha256)) throw new Error("invalid-maintenance-launch-scope");
      const activation = trimActivations.get(request.requestId);
      if (!activation || !isDeepStrictEqual(activation.request, request)) throw new Error("missing-or-stale-activation-scope");
      const scope = activation;
      if (!scope.valid()) throw new Error("missing-or-stale-activation-scope");
      if (scope.busy) return { content: [{ type: "text", text: JSON.stringify({status:"inflight",committed:false}) }], details: {status:"inflight",committed:false} };
      const signal = _signal ? AbortSignal.any([_signal,scope.signal]) : scope.signal;
      let result: any;
      scope.busy = true;
      try {
        if (params.operation === "contract") {
          const {branchIds,...summary}=request;
          result = {request:{...summary,branchEntryCount:branchIds.length},requestId, minimumBytes:MINIMUM,targetBytes:TARGET,maximumBytes:MAXIMUM,
            contract:"Prepare, inspect bounded category feedback, refine eligible historical payload categories if needed, then activate. Only verified persisted trimmed output is success."};
        } else if (params.operation === "inspect") {
          result = scope.feedback ?? {status:"not-prepared",committed:false};
        } else if (["prepare","refine","trim"].includes(params.operation)) {
          if ((scope.preparations ?? 0) >= 3) throw new Error("refinement-budget-exhausted");
          let selection = scope.selection ?? [];
          if (params.operation === "refine") {
            const proposal = params.categories;
            const catalog = scope.feedback?.catalog ?? [];
            if (!Array.isArray(proposal) || !proposal.length || proposal.length > 2 || new Set(proposal).size !== proposal.length
              || proposal.some((category: string) => !catalog.some((item: any) => item.category === category && item.potentialSavingsBytes > 0)
                || selection.includes(category))) throw new Error("invalid-refinement-category-proposal");
            selection = [...selection,...proposal];
          } else if (scope.feedback) throw new Error("already-prepared-use-inspect-or-refine");
          scope.preparations = (scope.preparations ?? 0) + 1;
          result = await runTrimWorker({action:"prepare",request,selection},signal);
          if (!scope.valid() || signal.aborted) throw new Error("maintenance-canceled-or-stale-scope");
          scope.selection = selection; scope.feedback = result;
          // Compatibility operation for existing callers; the agent uses the
          // explicit inspect/refine protocol, never an unvalidated replacement.
          if (params.operation === "trim" && result.withinTarget) {
            const activated = await scope.activateAsync(signal);
            result = {...result,...activated,committed:activated.status === "trimmed" || activated.status === "verification-pending"};
          }
        } else if (params.operation === "activate") {
          if (!scope.feedback?.withinTarget) throw new Error("accepted-preparation-required");
          const activated=await scope.activateAsync(signal);
          result = {...scope.feedback,...activated,committed:activated.status === "trimmed" || activated.status === "verification-pending"};
        } else throw new Error("unknown-maintenance-operation");
      } finally {
        scope.busy = false;
        if (!scope.valid() && !scope.request.committed) cleanupRequest(request);
      }
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result as Record<string, unknown> };
    },
  });
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
    if (request) { const scope = trimActivations.get(request.requestId); scope?.controller?.abort(); trimActivations.delete(request.requestId); }
    if (request?.committed) receipts.set(request.requestId, request);
    else if (request) cleanupRequest(request);
    request = undefined; due = undefined;
  };
  const outcome = (value: TrimResult) => {
    pi.sendMessage({ customType: "transcript-trim-outcome", display: true,
      content: value.status === "trimmed"
        ? `Transcript maintenance verified: ${value.before} → ${value.after} bytes (target ${TARGET}; accepted ${MINIMUM}–${MAXIMUM}).${value.appendedAfterCommitBytes ? ` Current file: ${value.currentBytes} bytes (${value.appendedAfterCommitBytes} appended after commit).` : ""}`
        : `Transcript maintenance not completed: ${value.reason}. Source was not reported as successfully trimmed.`,
      details: value }, { triggerTurn: false });
  };
  const bindActivation = (ctx: TrimContext & { signal?: AbortSignal }) => {
    const authorized = request!;
    const controller = new AbortController();
    const ownerSignal = ctx.signal ? AbortSignal.any([controller.signal,ctx.signal]) : controller.signal;
    let activationAttempted = false;
    const valid = () => !ownerSignal.aborted && request === authorized
      && trimActivations.get(authorized.requestId)?.request === authorized && same(identity(ctx),authorized);
    const publish = (result: TrimResult) => {
      if (authorized.committed) {
        if (result.status !== "trimmed") receipts.set(authorized.requestId,authorized);
        else receipts.delete(authorized.requestId);
        if (request === authorized) { request=undefined;due=undefined; }
      }
      try { if (!ownerSignal.aborted && same(identity(ctx),authorized)) outcome(result); } catch { /* UI delivery cannot undo a committed receipt. */ }
      return result;
    };
    trimActivations.set(authorized.requestId, { request: authorized, controller,signal:ownerSignal,valid,
      async activateAsync(signal) {
        if (activationAttempted) throw new Error("activation-already-attempted");
        activationAttempted = true;
        let result: TrimResult;
        try {
          if (!valid() || signal?.aborted) throw new Error("activation-canceled-or-session-changed");
          const branch=ctx.sessionManager.getBranch().map(e=>e.id);
          if(authorized.branchIds.some((id,i)=>branch[i]!==id))throw new Error("branch-changed");
          const prepared:any=await runTrimWorker({action:"activation",request:authorized,branchIds:branch},signal);
          // Short owner-only commit fence: no transcript parse/reduction/copy here.
          if(!valid() || signal?.aborted || !isDeepStrictEqual(branch,ctx.sessionManager.getBranch().map(e=>e.id))
            || pathIdentity(authorized.file,io)!==prepared.pathIdentity
            || sourceIdentity(io.lstatSync(authorized.file))!==prepared.sourceIdentity
            || prepared.finalFile!==join(authorized.directory,"activation.jsonl") || !ownedDirectory(authorized,io)
            || pathIdentity(prepared.finalFile,io).length===0
            || trimSourceIdentity(io.lstatSync(prepared.finalFile))!==prepared.finalIdentity)throw new Error("source-or-session-changed");
          const dir=io.openSync(dirname(authorized.file),"r");
          try {
            io.renameSync(prepared.finalFile,authorized.file);
            authorized.committed={sha256:prepared.sha256,bytes:prepared.bytes,before:prepared.before};
            trimActivations.delete(authorized.requestId);
            try{io.fsyncSync(dir);}catch{authorized.committed.warning="directory-sync-failed";}
          }finally{io.closeSync(dir);}
          // Readback runs off-thread too. After rename cancellation never replays it.
          const verified:any=await runTrimWorker({action:"readback",request:authorized});
          if(!cleanupRequest(authorized,io))throw new Error("staging-cleanup-pending");
          result={status:"trimmed",before:prepared.before,after:verified.after,
            currentBytes:verified.currentBytes,appendedAfterCommitBytes:verified.appendedAfterCommitBytes,
            ...(authorized.committed.warning?{reason:authorized.committed.warning}:{})};
        } catch(error) {
          result={status:authorized.committed?"verification-pending":"refused",before:authorized.committed?.before,
            after:authorized.committed?.bytes,reason:error instanceof Error?error.message:"activation-worker-failed"};
        }
        return publish(result);
      } });
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
        if (trimActivations.get(request.requestId)?.busy) return;
        const entries = ctx.sessionManager.getEntries?.()
          ?? parseTranscript(decode(io.readFileSync(request.file)), request.sessionId, true);
        const facts = extractionTranscriptFacts({ entries: entries as any[], requestId: request.requestId, job: "transcript-trim", now: Date.now(),
          successQualifies: () => false });
        if (facts.stopped) { cancel(); return; }
        const totalAttempts = (request.attemptOffset ?? 0) + facts.attemptCount;
        const next = extractionDue({...facts,attemptCount:totalAttempts});
        if (next.kind === "giveup") {
          const requestId = request.requestId; cancel();
          return { requestId, jobType: "transcript-trim", giveup: true };
        }
        // Running native work and pending delivery keep their exact scope. A
        // later SDK compaction is useful coverage only after that work settles.
        if (next.kind !== "launch") return;
        const branch = ctx.sessionManager.getBranch();
        const lastCompaction = [...branch].reverse().find(e=>e.type === "compaction");
        const freshCoverage = !!lastCompaction && !request.branchIds.includes(lastCompaction.id);
        const changed = digest(io.readFileSync(request.file).subarray(0,request.sourceBytes)) !== request.sourceSha256
          || request.branchIds.some((id,i)=>branch[i]?.id!==id);
        if (changed || freshCoverage) {
          const previous=request;
          trimActivations.get(previous.requestId)?.controller?.abort();
          trimActivations.delete(previous.requestId);cleanupRequest(previous);
          request=createTranscriptTrimRequest(ctx,freshCoverage?"new-native-compaction-coverage":"source-or-branch-changed",true);
          if(!request){due=undefined;return;}
          request.attemptOffset=totalAttempts;
          io.writeFileSync(request.varsFile,JSON.stringify(request),{mode:0o600});
        }
        // A retry must produce its own candidate, never inherit a prior attempt's staging.
        if (next.reminder > 0) {
          if (!ownedDirectory(request, io)) throw new Error("foreign-staging-directory");
          try { io.unlinkSync(request.candidateFile); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        }
        bindActivation(ctx);
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
