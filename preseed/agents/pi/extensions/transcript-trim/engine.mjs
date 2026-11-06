/** Private CPU worker library. Not an extension factory; no index file or startup lifecycle. */
import * as fs from 'node:fs';
import {createHash} from 'node:crypto';
import {dirname,join,parse,resolve} from 'node:path';
import {isDeepStrictEqual,TextDecoder} from 'node:util';
import {fileURLToPath} from 'node:url';
import {fork} from 'node:child_process';
import {getPriority,setPriority} from 'node:os';
const CAP=50_000_000,MINIMUM=15_000_000,TARGET=20_000_000,MAXIMUM=25_000_000;
const stateTypes=new Set(['rpiv-todo-state','goal-state','plan-mode-state']);
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const decode=bytes=>new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(bytes);
function todo(e)          {
  return e.type === "custom" && e.customType === "rpiv-todo-state";
}
function snapshot(d)          {
  return !!d && Array.isArray(d.tasks) && typeof d.nextId === "number" && Number.isFinite(d.nextId);
}
function encode(e)         { return JSON.stringify(e) + "\n"; }
function lastIndex   (entries, match)         {
  for (let i = entries.length - 1; i >= 0; i--) if (match(entries[i])) return i;
  return -1;
}

/** Strict complete JSONL; parents must precede children. Unknown records remain opaque. */
export function parseTranscript(raw, sessionId, allowExistingGaps = false)          {
  if (!raw.endsWith("\n")) throw new Error("incomplete-or-invalid-jsonl");
  const entries = raw.slice(0, -1).split("\n").map(line => JSON.parse(line));
  const header = entries[0];
  if (!header || header.type !== "session" || header.id !== sessionId || header.parentSession) throw new Error("foreign-or-child-session");
  if (header.version !== 3) throw new Error("unsupported-session-version");
  const ids = new Set();
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
export function prepareTranscript(raw, sessionId, branchIds)                     {
  const entries = parseTranscript(raw, sessionId);
  const lines = raw.slice(0, -1).split("\n").map(line => line + "\n");
  let size = Buffer.byteLength(raw);
  if (size <= CAP) return undefined;
  const byId = new Map(entries.slice(1).map((e, i) => [e.id, i + 1]));
  if (branchIds.length === 0 || branchIds.some((id, i) => !byId.has(id)
    || entries[byId.get(id) ].parentId !== (i ? branchIds[i - 1] : null))) throw new Error("foreign-branch");
  const nearest = new Map();
  const children = new Map();
  const keep = new Set();
  const checkpoints = new Set();
  for (const e of entries.slice(1)) children.set(e.parentId, (children.get(e.parentId) ?? 0) + 1);
  for (const e of entries.slice(1)) nearest.set(e.id, todo(e) ? e.id : nearest.get(e.parentId));
  const retain = (id) => {
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
  const changes = new Map();
  const replace = (i, e) => {
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
    const state = stateId ? entries[byId.get(stateId) ].data : undefined;
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
  const covered = (ids)              => {
    const compactAt = lastIndex(ids, id => entries[byId.get(id) ].type === "compaction");
    if (compactAt < 0) return new Set();
    const firstKept = ids.indexOf(entries[byId.get(ids[compactAt]) ].firstKeptEntryId);
    return firstKept < 0 || firstKept > compactAt ? new Set() : new Set(ids.slice(0, firstKept));
  };
  const eligible = covered(branchIds);
  // Mark unsummarized endpoint paths in one tree pass, rather than rebuilding
  // every ancestry in repeatedly forked histories. Index 0 is the virtual root.
  const parents = new Int32Array(entries.length);
  const descendants= entries.map(() => []);
  for (let i = 1; i < entries.length; i++) {
    const parent = byId.get(entries[i].parentId) ?? 0;
    parents[i] = parent;
    descendants[parent].push(i);
  }
  const boundaries = new Int32Array(entries.length);
  const onPath = new Uint8Array(entries.length);
  const protection = new Int32Array(entries.length);
  const visit= [[0, false]];
  while (visit.length) {
    const [i, leaving] = visit.pop() ;
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
      && m.content.some((block) => block?.type === "thinking")) {
      replace(i, { ...e, message: { ...m, content: m.content.map((block) => block?.type === "thinking"
        ? { type: "thinking", thinking: "[Historical reasoning trimmed.]" } : block) } });
    }
  }
  // Only completed built-in raw results with no structured/state-bearing fields are eligible.
  const calls = new Map                                         ();
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
      || !m.content.every((b) => b?.type === "text" || b?.type === "image")) continue;
    let ancestor = e.parentId;
    while (ancestor && ancestor !== entries[call.index].id) ancestor = entries[byId.get(ancestor) ].parentId;
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
  const restored = new Map();
  for (const e of checked.slice(1)) restored.set(e.id, todo(e) ? e.id : restored.get(e.parentId));
  for (const checkpoint of checkpoints) {
    if (restored.get(checkpoint) !== nearest.get(checkpoint)) throw new Error("lost-checkpoint");
  }
  return candidate;
}

// Native SDK notifications are extension-authored messages, not human user text.
// Keep correlation, terminal status, usage and every unknown renderer field.
function historicalNotification(entry) {
  if (entry.type !== 'custom_message' || entry.customType !== 'subagent-notification'
    || typeof entry.content !== 'string' || typeof entry.details?.resultPreview !== 'string'
    || !['completed','error','aborted','stopped'].includes(entry.details.status)
    || typeof entry.details.id !== 'string') return false;
  return /^<task-notification>\n<task-id>[^<]+<\/task-id>\n(?:<tool-use-id>[^<]+<\/tool-use-id>\n)?(?:<output-file>[^<]+<\/output-file>\n)?<status>[^<]+<\/status>\n<summary>[^<]*<\/summary>\n<result>[^<]*<\/result>\n<usage><total_tokens>\d+<\/total_tokens><tool_uses>\d+<\/tool_uses>(?:<context_percent>\d+<\/context_percent>)?(?:<compactions>\d+<\/compactions>)?<duration_ms>\d+<\/duration_ms><\/usage>\n<\/task-notification>(?:$|\n)/.test(entry.content);
}
function reduceNotification(entry) {
  return {...entry,content:entry.content.replace(/<result>[^<]*<\/result>/,'<result>[Historical result trimmed]</result>'),
    details:{...entry.details,resultPreview:''}};
}
function executionArguments(block) {
  if (block?.type !== 'toolCall' || block.name !== 'ctx_batch_execute' || !Array.isArray(block.arguments?.commands)) return block;
  return {...block,arguments:{...block.arguments,commands:block.arguments.commands.map(command=>
    command && typeof command==='object' && !Array.isArray(command) && typeof command.label==='string' && typeof command.command==='string'
      ? {...command,command:'[Obsolete historical payload trimmed]'} : command)}};
}
const categories=['historical-notification-results','historical-execution-inputs'];
function refineEntry(entry,selection) {
  if (selection.includes(categories[0]) && historicalNotification(entry)) return reduceNotification(entry);
  if (selection.includes(categories[1]) && entry.type==='message' && entry.message?.role==='assistant' && Array.isArray(entry.message.content))
    return {...entry,message:{...entry.message,content:entry.message.content.map(executionArguments)}};
  return entry;
}
export function transcriptTrimCatalog(raw,sessionId,branchIds) {
  const entries=parseTranscript(raw,sessionId,true),eligible=historicalEligibility(entries,branchIds);
  return categories.map(category=>{
    let potentialSavingsBytes=0,eligibleRecords=0;
    for(const entry of entries) if(eligible.has(entry.id)) {
      const savings=Buffer.byteLength(JSON.stringify(entry))-Buffer.byteLength(JSON.stringify(refineEntry(entry,[category])));
      if(savings>0){potentialSavingsBytes+=savings;eligibleRecords++;}
    }
    return {category,eligibleRecords,potentialSavingsBytes};
  });
}

function historicalSubagentResult(entry)          {
  const data = entry.data;
  return entry.type === "custom" && entry.customType === "subagents:record" && data
    && typeof data.id === "string" && typeof data.type === "string" && typeof data.description === "string"
    && ["completed", "error", "aborted"].includes(data.status) && Number.isFinite(data.completedAt)
    && typeof data.outputFile === "string" && typeof data.result === "string" && Number.isFinite(data.toolUses);
}

function obsoleteEditDetails(details)      {
  return details && typeof details.diff === "string" && typeof details.patch === "string"
    && Number.isFinite(details.firstChangedLine) ? { ...details, diff: "", patch: "" } : details;
}

/** Eligibility is not lossless restoration of every historical branch checkpoint.
 * Protect the current active conversation/frontier and latest known authority;
 * the semantic agent may condense superseded payloads on inactive branches. */
export function activeHistory(entries, branchIds= [])                                                           {
  const index = new Map(entries.slice(1).map((e, i) => [e.id, i + 1]));
  const leaf = branchIds.at(-1) ?? entries.at(-1)?.id;
  if (leaf && !index.has(leaf) && entries.length > 1) throw new Error("foreign-active-leaf");
  let active;
  if (branchIds.length) {
    if (new Set(branchIds).size !== branchIds.length || branchIds.some((id, i) => i > 0 && index.has(id)
      && entries[index.get(id) ].parentId !== branchIds[i - 1])) throw new Error("foreign-branch-projection");
    // Keep the full loaded ancestry as authority; project only persisted records.
    // Missing records are never restored, and a disk gap cannot hide current context.
    active = branchIds.map(id => index.get(id)).filter((i)              => i !== undefined);
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
function historicalEligibility(entries, branchIds= [])              {
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
    && ((entry.type === "custom" && stateTypes.has(entry.customType)) || historicalSubagentResult(entry) || historicalNotification(entry) || entry.type === "compaction"
      || (entry.type === "message" && ["assistant", "system", "toolResult"].includes(entry.message?.role)))).map(e => e.id));
}

// Superseded task snapshots are internal metadata, not current message content.
// Keep the latest global and active-branch authority, even inside the frontier.
function supersededTodoData(entries, branchIds)              {
  const active = new Set(activeHistory(entries, branchIds).active.map(i => entries[i].id));
  const global = lastIndex(entries, todo);
  const branch = lastIndex(entries, e => active.has(e.id) && todo(e));
  return new Set(entries.filter((entry, i) => {
    if (todo(entry)) return i !== global && i !== branch;
    return entry.type === "message" && entry.message?.role === "toolResult" && entry.message.toolName === "todo"
      && snapshot(entry.message.details) && i < global && (!active.has(entry.id) || i < branch);
  }).map(entry => entry.id));
}

function obsoleteSystemPayload(message)      {
  if (!message || message.role !== "system") return message;
  const content = Array.isArray(message.content)
    ? message.content.filter((block) => !sameHistoricalBlocks([block], [])) : [];
  return { ...message, content,
    ...(Array.isArray(message.toolsAdded) ? { toolsAdded: [] } : {}),
    ...(Array.isArray(message.toolsRemoved) ? { toolsRemoved: [] } : {}),
    ...(message.sections && typeof message.sections === "object" && !Array.isArray(message.sections)
      && Object.values(message.sections).every(value => value === null || typeof value === "string") ? { sections: {} } : {}),
  };
}

function obsoleteCompactionDetails(details)      {
  const state = details?.compactionState;
  // pi-smart-compact's documented structured state is a superseded checkpoint,
  // not provider-native opaque state. Preserve every other detail/native field.
  const arrays = ["decisions", "constraints", "modifiedFiles", "readFiles", "deletedFiles", "unresolvedErrors", "resolvedErrors",
    "openLoops", "loopOverrides", "factOverrides", "topics", "criticalContext", "nextActions"];
  if (!details || typeof details.version !== "string" || !/^10\.\d+\.\d+$/.test(details.version)
    || !state || typeof state !== "object" || !(state.goal === null || typeof state.goal === "string")
    || !["decisions", "constraints", "modifiedFiles", "readFiles"].every(key => Array.isArray(state[key]))) return details;
  const provenance = details.provenance;
  const knownProvenance = provenance && Number.isFinite(provenance.initialScore) && Number.isFinite(provenance.finalScore)
    && typeof provenance.llmPatched === "boolean" && Array.isArray(provenance.deterministicPatched)
    && Array.isArray(provenance.remainingGaps);
  return { ...details,
    ...Object.fromEntries(arrays.filter(key => Array.isArray(details[key])).map(key => [key, []])),
    ...(knownProvenance ? { provenance: { ...provenance, deterministicPatched: [] } } : {}),
    compactionState: { ...state,
      ...Object.fromEntries(arrays.filter(key => Array.isArray(state[key])).map(key => [key, []])),
    },
  };
}

// These are known prose-bearing fields, not a blanket exemption for tool arguments.
// All other argument keys and every tool-call envelope remain opaque/wire-stable.
const historicalArgumentFields= {
  read: ["path"], bash: ["command"], write: ["content"], edit: ["oldText", "newText"],
  ctx_execute: ["code"], ctx_execute_file: ["code"], subagent: ["prompt"], steer_subagent: ["message"], todo: ["description"],
};
function frozenExtractionCall(block)          {
  return block?.type === "toolCall" && block.name === "subagent" && typeof block.arguments?.prompt === "string"
    && block.arguments.prompt.includes("CODEFLARE_EXTRACTION_REQUEST=");
}
function sameHistoricalBlocks(before, after)          {
  // Unsupported metadata makes the entire block opaque. Only schema-shaped,
  // metadata-free payload blocks may be replaced or removed by semantic work.
  const mutablePayload = (block)          => {
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
  const opaque = (content) => Array.isArray(content) ? content.filter(block => !mutablePayload(block)) : [];
  const original = opaque(before), candidate = opaque(after);
  if (original.length !== candidate.length) return false;
  return original.every((block, i) => {
    const next = candidate[i];
    if(block?.type==='toolCall' && block.name==='ctx_batch_execute') {
      const reduced=executionArguments(block);
      if(!isDeepStrictEqual(reduced,block)) {
        // Only this catalog-owned replacement is accepted, not arbitrary nested JSON.
        return isDeepStrictEqual(block,next)||isDeepStrictEqual(reduced,next);
      }
    }
    const fields = block?.type === "toolCall" && !frozenExtractionCall(block) ? historicalArgumentFields[block.name] : undefined;
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
      args.edits = block.arguments.edits.map((edit, i) => {
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
export function validateTranscriptTrimCandidate(source, candidate, sessionId, branchIds= [])       {
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
    } else if (historicalNotification(a)) {
      expected = reduceNotification(a);
    } else if (historicalSubagentResult(a)) {
      expected = { ...a, data: { ...a.data, result: "" } };
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
      if (m.role === "toolResult" && m.toolName === "edit" && !isDeepStrictEqual(m.details, n.details)) {
        expected.message = { ...expected.message, details: obsoleteEditDetails(m.details) };
      }
      if (m.role === "toolResult" && m.toolName === "todo" && snapshot(m.details)) {
        // Only the recognized duplicate snapshot fields may change; any extension
        // fields remain opaque even when attached to a historical Todo result.
        const opaqueDetails = (details) => Object.fromEntries(Object.entries(details ?? {})
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
function retainHistoricalProse(entry, reduced, byteLimit)        {
  if (!Array.isArray(entry.message?.content) || !Array.isArray(reduced.message?.content)) return reduced;
  const content = reduced.message.content, retained= [];
  let used = Buffer.byteLength(JSON.stringify(reduced)), count = content.length;
  for (const block of entry.message.content) {
    const key = block?.type === "text" ? "text" : block?.type === "thinking" ? "thinking" : undefined;
    if (!key || typeof block[key] !== "string" || !sameHistoricalBlocks([block], [])) continue;
    const original = block[key];
    const overhead = Buffer.byteLength(JSON.stringify({ ...block, [key]: "" })) + (count > 0 ? 1 : 0);
    let available = byteLimit - used - overhead, length = 0;
    if (available < 0) break;
    const initialAvailable = available;
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
    if (length > 0) {
      retained.push({ ...block, [key]: original.slice(0, length) });
      used += overhead + initialAvailable - available; count++;
    }
    if (length < original.length) break;
  }
  return retained.length ? { ...reduced, message: { ...reduced.message, content: [...content, ...retained] } } : reduced;
}

export function prepareLocalTranscriptTrim(raw, sessionId, branchIds, budget, selection = []) {
  const entries = parseTranscript(raw, sessionId, true), eligible = historicalEligibility(entries, branchIds);
  const obsoleteTasks = supersededTodoData(entries, branchIds);
  const lines = raw.slice(0, -1).split("\n");
  let size = Buffer.byteLength(raw);
  const preferred = Math.min(TARGET, budget);
  let lastReduced = 0;
  for (let i = 1; i < entries.length && size > preferred; i++) {
    let entry = entries[i];
    if (!eligible.has(entry.id) && !obsoleteTasks.has(entry.id)) continue;
    let reduced = refineEntry(entry,selection);
    if(!isDeepStrictEqual(reduced,entry)) {
      const line=JSON.stringify(reduced),savings=Buffer.byteLength(lines[i])-Buffer.byteLength(line);
      if(savings>0){lines[i]=line;size-=savings;lastReduced=i;}
    }
    if (historicalNotification(entry)) continue;
    // Legacy payload reduction composes with the selected safe argument transform.
    entry=reduced;
    if (todo(entry)) reduced = { ...entry, data: { ...entry.data, tasks: [] } };
    else if (entry.type === "custom" && stateTypes.has(entry.customType)) reduced = { ...entry, data: {} };
    else if (historicalSubagentResult(entry)) reduced = { ...entry, data: { ...entry.data, result: "" } };
    else if (entry.type === "compaction") reduced = { ...entry, summary: "[Obsolete historical summary trimmed]",
      ...(entry.systemMessage?.role === "system" ? { systemMessage: obsoleteSystemPayload(entry.systemMessage) } : {}),
      ...(entry.details !== undefined ? { details: obsoleteCompactionDetails(entry.details) } : {}),
    };
    else if (entry.type === "message") {
      const message = entry.message;
      const content = eligible.has(entry.id) ? (Array.isArray(message.content) ? message.content : []).filter((block) => !sameHistoricalBlocks([block], [])).map((block) => {
        const fields = block?.type === "toolCall" && !frozenExtractionCall(block) ? historicalArgumentFields[block.name] : undefined;
        if (!fields || !block.arguments || typeof block.arguments !== "object" || Array.isArray(block.arguments)) return block;
        const args = { ...block.arguments };
        for (const key of fields) if (typeof args[key] === "string" && args[key].length > 64) args[key] = "[Obsolete historical payload trimmed]";
        if (block.name === "edit" && Array.isArray(args.edits)) args.edits = args.edits.map((edit) => {
          if (!edit || typeof edit !== "object" || Array.isArray(edit)) return edit;
          const reduced = { ...edit };
          for (const key of ["oldText", "newText"]) if (typeof reduced[key] === "string" && reduced[key].length > 64) reduced[key] = "[Obsolete historical payload trimmed]";
          return reduced;
        });
        return { ...block, arguments: args };
      }) : message.content;
      const next = eligible.has(entry.id) && message.role === "system"
        ? { ...obsoleteSystemPayload(message), content } : { ...message, content };
      if (eligible.has(entry.id) && message.role === "toolResult" && message.toolName === "edit") next.details = obsoleteEditDetails(message.details);
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
  const retention = {};
  const active = activeHistory(entries,branchIds), current = new Set(active.active.slice(active.start).map(i=>entries[i].id));
  for(let i=0;i<entries.length;i++) {
    const e=entries[i];
    const reason=i===0?'header':e.type==='message'&&e.message?.role==='user'?'human-user':
      eligible.has(e.id)?historicalNotification(e)?'historical-notification-envelope':e.type==='message'?'historical-message-envelope-and-opaque':
        'historical-known-state-envelope':obsoleteTasks.has(e.id)?'superseded-todo-envelope':current.has(e.id)?'current-context':
        (e.type==='custom'&&stateTypes.has(e.customType))||e.type==='compaction'?'latest-authority':'unknown-or-opaque';
    const item=retention[reason]??={records:0,bytes:0};item.records++;item.bytes+=Buffer.byteLength(lines[i])+1;
  }
  return { candidate, remainingBytes: size, retention, withinTarget: size >= MINIMUM && size <= Math.min(MAXIMUM, budget) };
}


function pathIdentity(file) {
  if(resolve(file)!==file)throw Error('unsafe-path');
  const root=parse(file).root,parts=file.slice(root.length).split('/');let current=root;
  return [root,...parts].map((part,i)=>{if(i)current=join(current,part);const s=fs.lstatSync(current);
    if(s.isSymbolicLink()||(i<parts.length?!s.isDirectory():!s.isFile()))throw Error('unsafe-path');return `${s.dev}:${s.ino}`;}).join('/');
}
export const trimSourceIdentity=s=>`${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.uid}:${s.gid}:${s.mode}:${s.nlink}`;
function directoryOwned(r) {
  const s=fs.lstatSync(r.directory);
  if(!s.isDirectory()||s.isSymbolicLink()||s.uid!==process.getuid?.()||`${s.dev}:${s.ino}`!==r.directoryIdentity)throw Error('foreign-staging-directory');
}
const COPY_CHUNK=64*1024;
function copyRange(fd,start,end,write) {
  const buffer=Buffer.allocUnsafe(COPY_CHUNK);
  for(let position=start;position<end;) {
    const count=fs.readSync(fd,buffer,0,Math.min(buffer.length,end-position),position);
    if(!count)throw Error('source-short-read');
    write(buffer.subarray(0,count));position+=count;
  }
}
export function hashTranscriptPrefix(file,length,io=fs) {
  const hash=createHash('sha256'),buffer=Buffer.allocUnsafe(COPY_CHUNK),fd=io.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try{for(let position=0;position<length;){const count=io.readSync(fd,buffer,0,Math.min(buffer.length,length-position),position);if(!count)throw Error('source-short-read');hash.update(buffer.subarray(0,count));position+=count;}}
  finally{io.closeSync(fd);}
  return hash.digest('hex');
}
function newlineAfter(fd,start,end) {
  const buffer=Buffer.allocUnsafe(COPY_CHUNK);
  for(let position=start;position<end;) {
    const count=fs.readSync(fd,buffer,0,Math.min(buffer.length,end-position),position);
    if(!count)throw Error('source-short-read');
    const at=buffer.subarray(0,count).indexOf(10);if(at>=0)return position+at+1;position+=count;
  }
  throw Error('incomplete-jsonl');
}
function rawCut(fd,length,tailBytes=0) {
  const header=newlineAfter(fd,0,length);
  const position=Math.min(length,Math.max(header,header+length+tailBytes-TARGET));
  const cut=position===length?length:newlineAfter(fd,position,length);
  const projectedBytes=header+length-cut+tailBytes;
  if(projectedBytes<MINIMUM)throw Error('retained-output-below-minimum');
  if(projectedBytes>MAXIMUM)throw Error('retained-output-above-maximum');
  return {header,cut,cutPercent:100*(cut-header)/(length+tailBytes-header),projectedBytes};
}
function stageRanges(r,target,ranges,stat) {
  directoryOwned(r);
  try{const s=fs.lstatSync(target);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.uid!==process.getuid?.())throw Error('foreign-candidate');fs.unlinkSync(target);}catch(e){if(e.code!=='ENOENT')throw e;}
  const out=fs.openSync(target,fs.constants.O_WRONLY|fs.constants.O_CREAT|fs.constants.O_EXCL|fs.constants.O_NOFOLLOW,0o600),hash=createHash('sha256');let bytes=0;
  try {
    for(const [fd,start,end]of ranges)copyRange(fd,start,end,chunk=>{for(let at=0;at<chunk.length;){const written=fs.writeSync(out,chunk,at,chunk.length-at);if(!written)throw Error('staging-short-write');at+=written;}hash.update(chunk);bytes+=chunk.length;});
    if(stat){fs.fchownSync(out,stat.uid,stat.gid);fs.fchmodSync(out,stat.mode&0o7777);}fs.fsyncSync(out);
  }finally{fs.closeSync(out);}
  return {bytes,sha256:hash.digest('hex')};
}
function workerJob({action,request:r}) {
  directoryOwned(r);const stamp=pathIdentity(r.file),stat=fs.lstatSync(r.file);
  if(stat.uid!==process.getuid?.()||stat.nlink!==1)throw Error('foreign-ownership');
  if(action==='readback') {
    if(!r.committed||r.committed.bytes<MINIMUM||r.committed.bytes>MAXIMUM||stat.size<r.committed.bytes||hashTranscriptPrefix(r.file,r.committed.bytes)!==r.committed.sha256)throw Error('persisted-verification-failed');
    return {after:r.committed.bytes,currentBytes:stat.size,appendedAfterCommitBytes:stat.size-r.committed.bytes};
  }
  if(r.policy!=='oldest-prefix-percent')throw Error('obsolete-maintenance-scope');
  for(const file of [r.candidateFile,join(r.directory,'activation.jsonl')])try{const staged=fs.lstatSync(file);if(!staged.isFile()||staged.isSymbolicLink()||staged.nlink!==1||staged.uid!==stat.uid)throw Error('foreign-candidate');}catch(e){if(e.code!=='ENOENT')throw e;}
  if(stamp!==r.sourcePathIdentity||stat.size<r.sourceBytes||hashTranscriptPrefix(r.file,r.sourceBytes)!==r.sourceSha256)throw Error('source-prefix-changed');
  const fd=fs.openSync(r.file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
  try {
    const ending=Buffer.allocUnsafe(1);
    for(const end of [r.sourceBytes,stat.size])if(fs.readSync(fd,ending,0,1,end-1)!==1||ending[0]!==10)throw Error('incomplete-jsonl');
    const {header,cut,cutPercent,projectedBytes}=rawCut(fd,r.sourceBytes,stat.size-r.sourceBytes);
    if(action==='prepare')return {requestId:r.requestId,status:'prepared',policy:r.policy,withinTarget:true,committed:false,
      candidateBytes:header+r.sourceBytes-cut,remainingBytes:projectedBytes,projectedTotalBytes:projectedBytes,budgetBytes:MAXIMUM-(stat.size-r.sourceBytes),cutPercent,removedBytes:cut-header};
    if(action!=='activation')throw Error('unknown-worker-action');
    const finalFile=join(r.directory,'activation.jsonl');
    const final=stageRanges(r,finalFile,[[fd,0,header],[fd,cut,stat.size]],stat);
    if(trimSourceIdentity(fs.lstatSync(r.file))!==trimSourceIdentity(stat)||pathIdentity(r.file)!==stamp)throw Error('source-or-session-changed');
    return {finalFile,sourceIdentity:trimSourceIdentity(stat),pathIdentity:stamp,before:stat.size,bytes:final.bytes,cutPercent,sha256:final.sha256,finalIdentity:trimSourceIdentity(fs.lstatSync(finalFile))};
  }finally{fs.closeSync(fd);}
}

const WORKER_MEMORY_BYTES=1_073_741_824;
const WORKER_MEMORY_ROOT='/sys/fs/cgroup/codeflare-trim-workers';
function memoryEvents(directory) {
  return Object.fromEntries(fs.readFileSync(join(directory,'memory.events'),'utf8').trim().split('\n').map(line=>{const [name,count]=line.split(' ');return [name,Number(count)];}));
}
function verifyMemoryGroup(directory,pid) {
  if(process.platform!=='linux'||fs.statfsSync(directory).type!==0x63677270
    ||!directory.startsWith(WORKER_MEMORY_ROOT+'/job-')
    ||fs.realpathSync(dirname(directory))!==WORKER_MEMORY_ROOT)throw Error('worker-memory-limit-unavailable');
  for(const group of [directory]) {
    if(fs.readFileSync(join(group,'memory.max'),'utf8').trim()!==String(WORKER_MEMORY_BYTES)
      ||fs.readFileSync(join(group,'memory.swap.max'),'utf8').trim()!=='0')throw Error('worker-memory-limit-unavailable');
  }
  if(fs.readFileSync(join(directory,'memory.oom.group'),'utf8').trim()!=='1'
    ||!fs.readFileSync(join(directory,'cgroup.procs'),'utf8').trim().split('\n').includes(String(pid)))throw Error('worker-memory-limit-unavailable');
}
function createWorkerMemoryGroup() {
  let directory;
  try {
    if(process.platform!=='linux'||fs.statfsSync('/sys/fs/cgroup').type!==0x63677270)throw Error();
    try{fs.mkdirSync(WORKER_MEMORY_ROOT);}catch(e){if(e.code!=='EEXIST')throw e;}
    // This empty controller contains trim workers only, never the Pi/host process.
    fs.writeFileSync(join(WORKER_MEMORY_ROOT,'cgroup.subtree_control'),'+memory');
    directory=fs.mkdtempSync(join(WORKER_MEMORY_ROOT,`job-${process.pid}-`));
    fs.writeFileSync(join(directory,'memory.max'),String(WORKER_MEMORY_BYTES));
    fs.writeFileSync(join(directory,'memory.swap.max'),'0');
    fs.writeFileSync(join(directory,'memory.oom.group'),'1');
    return {directory,oomBefore:memoryEvents(directory).oom_kill??0};
  }catch {
    if(directory)try{fs.rmdirSync(directory);}catch{}
    throw Error('worker-memory-limit-unavailable');
  }
}

/** One independently scheduled CPU job. IPC contains bounded metadata, never transcript text. */
export function runTrimWorker(job,signal,launch=fork) {
  if(signal?.aborted)return Promise.reject(Error('maintenance-canceled'));
  return new Promise((resolve,reject)=>{
    let child,result,error,memory,settled=false,terminating=false;
    const cleanup=()=>{
      signal?.removeEventListener('abort',abort);
      child?.removeListener('message',message);
      child?.removeListener('error',failed);
      child?.removeListener('exit',terminal);
      child?.removeListener('close',terminal);
      if(memory)try{fs.rmdirSync(memory.directory);}catch{}
    };
    const settle=()=>{
      if(settled)return;
      settled=true;cleanup();
      if(error)reject(error);else resolve(result);
    };
    const failed=e=>{
      if(settled)return;
      error??=e;
      // Failed spawn may emit error/close without ever emitting exit.
      if(!child?.pid){settle();return;}
      if(child.exitCode!==null || child.signalCode!==null){terminal(child.exitCode);return;}
      if(!terminating){terminating=true;try{child.kill('SIGTERM');}catch(killError){error=killError;}}
    };
    const abort=()=>failed(Error('maintenance-canceled'));
    const message=value=>{
      if(settled)return;
      if(value?.ok)result=value.value;
      else failed(Error(value?.error??'worker-failed'));
    };
    const terminal=code=>{
      if(settled)return;
      if(code!==0 || result===undefined) {
        let oom=false;try{oom=memoryEvents(memory.directory).oom_kill>memory.oomBefore;}catch{}
        if(oom && error?.message!=='maintenance-canceled')error=Error('worker-oom-killed:1073741824');
        else error??=Error('worker-exited-without-result');
      } else if(result && typeof result==='object') {
        result.workerMemoryLimitBytes=WORKER_MEMORY_BYTES;
        try{result.workerPeakMemoryBytes=Number(fs.readFileSync(join(memory.directory,'memory.peak'),'utf8').trim());}catch{}
      }
      settle();
    };
    try{
      memory=createWorkerMemoryGroup();
      // The shell cannot exec Node until its PID is inside the verified limit.
      child=launch(fileURLToPath(import.meta.url),['--trim-worker'],{
        execPath:'/bin/sh',execArgv:['-c','IFS= read -r gate <&4 || exit 1; exec 4<&-; exec "$@"','codeflare-trim',process.execPath],
        stdio:['ignore','ignore','ignore','ipc','pipe'],
        env:{...process.env,CODEFLARE_TRIM_MEMORY_GROUP:memory.directory},
      });
      child.on('message',message);child.on('error',failed);child.once('exit',terminal);child.once('close',terminal);
      signal?.addEventListener('abort',abort,{once:true});
      child.stdio[4]?.on('error',failed);
      if(signal?.aborted){abort();return;}
      if(!child.pid)return;
      try {
        fs.writeFileSync(join(memory.directory,'cgroup.procs'),String(child.pid));
        verifyMemoryGroup(memory.directory,child.pid);
        child.stdio[4].end('go\n');
        child.send(job,e=>{if(e)failed(e);});
      }catch(e){failed(e);}
    }catch(e){error=e;settle();}
  });
}
if(process.argv[2]==='--trim-worker' && process.send && resolve(process.argv[1]??'')===fileURLToPath(import.meta.url)) {
  // This adjusts only the independent CPU process, never Pi's UI/session thread.
  let priorityReady=true;
  try{verifyMemoryGroup(process.env.CODEFLARE_TRIM_MEMORY_GROUP??'',process.pid);}
  catch{priorityReady=false;process.exitCode=1;process.send({ok:false,error:'worker-memory-limit-unavailable'},()=>process.disconnect());}
  if(priorityReady)try{setPriority(0,Math.max(getPriority(0),10));}catch{priorityReady=false;process.exitCode=1;process.send({ok:false,error:'worker-priority-unavailable'},()=>process.disconnect());}
  if(priorityReady)process.once('message',job=>{
    let response;try{response={ok:true,value:{...workerJob(job),workerPriority:getPriority(0)}};}catch(e){const message=e instanceof Error?e.message:'';response={ok:false,error:/^[a-z][a-z0-9-]+(?::[A-Za-z0-9_-]+)?$/.test(message)?message:'invalid-transcript-or-worker-failure'};}
    process.send(response,()=>process.disconnect());
  });
}
