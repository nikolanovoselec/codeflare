import { constants } from "node:fs";
import {
  access,
  chmod,
  lstat,
  mkdir,
  open,
  readFile as readLocalFile,
  realpath,
  rename,
  rm,
  rmdir,
  writeFile as writeLocalFile,
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { createHash, randomUUID as createRandomUUID } from "node:crypto";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { spawn } from "node:child_process";

import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  BashOperations,
  BashToolInput,
  EditOperations,
  EditToolInput,
  ExtensionAPI,
  ExtensionContext,
  ToolDefinition,
  WriteOperations,
  WriteToolInput,
} from "@earendil-works/pi-coding-agent";

export const SIDEBAR_APPROVAL_SOURCE = "extensions/sidebar-approval.ts";
const WORKSPACE_ROOT = "/home/user/workspace";
const MANIFEST_ROOT = "/tmp/codeflare-sidebar/pi/approvals";
const APPROVAL_TTL_MS = 30_000;
const MAX_GENERIC_INPUT_BYTES = 64 * 1024;
const MAX_PREVIEW_BYTES = 768 * 1024;
const MAX_APPROVAL_MANIFEST_BYTES = 1024 * 1024;
const MAX_BASH_OUTPUT_BYTES = 1024 * 1024;

export type SidebarApprovalPreview =
  | { kind: "diff"; path: string; diff: string; beforeSha256: string; afterSha256: string }
  | { kind: "bash"; command: string; cwd: string }
  | { kind: "generic"; toolName: string; input: unknown };

export interface SidebarApprovalRequest {
  id: string;
  nonce: string;
  toolName: string;
  createdAt: number;
  expiresAt: number;
  preview: SidebarApprovalPreview;
}

export interface SidebarApprovalDecision {
  id: string;
  approved: boolean;
}

export interface SidebarPathInfo {
  absolutePath: string;
  canonicalPath: string;
  exists: boolean;
  symbolicLink: boolean;
  regularFile?: boolean;
  hardLinked?: boolean;
  safeAncestors?: boolean;
}

type MutationQueue = <T>(filePath: string, operation: () => Promise<T>) => Promise<T>;

export interface SidebarApprovalDependencies {
  workspaceRoot?: string;
  editOperations?: EditOperations;
  writeOperations?: WriteOperations;
  bashOperations?: BashOperations;
  inspectPath?: (path: string, cwd: string) => Promise<SidebarPathInfo>;
  readFile?: (absolutePath: string) => Promise<Buffer>;
  requestApproval?: (request: SidebarApprovalRequest, ctx: ExtensionContext) => Promise<SidebarApprovalDecision>;
  now?: () => number;
  randomUUID?: () => string;
  sha256?: (content: Buffer | string) => Promise<string> | string;
  withFileMutationQueue?: MutationQueue;
  baseTools?: Partial<Record<"edit" | "write" | "bash", ToolDefinition>>;
}

export interface SidebarApprovalDetails {
  approvalId?: string;
  postWriteSha256?: string;
  diff?: string;
  patch?: string;
  denied?: string;
}

type SidebarApprovalTool<TInput> = Omit<ToolDefinition, "execute"> & {
  execute(
    toolCallId: string,
    params: TInput,
    signal: AbortSignal | undefined,
    onUpdate: AgentToolUpdateCallback<SidebarApprovalDetails | undefined> | undefined,
    ctx: ExtensionContext,
  ): Promise<AgentToolResult<SidebarApprovalDetails | undefined>>;
};

export interface SidebarApprovalTools {
  edit: SidebarApprovalTool<EditToolInput>;
  write: SidebarApprovalTool<WriteToolInput>;
  bash: SidebarApprovalTool<BashToolInput>;
}

export function createSidebarApprovalTools(
  dependencies: SidebarApprovalDependencies = {},
): SidebarApprovalTools {
  const workspaceRoot = resolve(dependencies.workspaceRoot ?? WORKSPACE_ROOT);
  const inspectPath = dependencies.inspectPath ?? inspectLocalPath;
  const readFile = dependencies.readFile ?? readLocalFile;
  const editOperations = dependencies.editOperations ?? localEditOperations;
  const writeOperations = dependencies.writeOperations ?? localWriteOperations;
  const bashOperations = dependencies.bashOperations ?? localBashOperations;
  const requestApproval = dependencies.requestApproval ?? requestHostApproval;
  const now = dependencies.now ?? Date.now;
  const randomUUID = dependencies.randomUUID ?? createRandomUUID;
  const sha256 = dependencies.sha256 ?? hashSha256;
  const mutationQueue = dependencies.withFileMutationQueue ?? createMutationQueue();
  const useSecureEditBoundary = dependencies.editOperations === undefined;
  const useSecureWriteBoundary = dependencies.writeOperations === undefined && dependencies.readFile === undefined;

  const approve = async (
    toolName: string,
    preview: SidebarApprovalPreview,
    ctx: ExtensionContext,
  ): Promise<{ request: SidebarApprovalRequest; approved: boolean; reason?: string }> => {
    if (ctx.mode !== "rpc" || !ctx.hasUI) {
      return { request: emptyRequest(toolName, preview), approved: false, reason: "Sidebar RPC approval UI is unavailable." };
    }
    const createdAt = now();
    const id = randomUUID();
    if (!isOpaqueId(id)) return { request: emptyRequest(toolName, preview), approved: false, reason: "Approval ID was invalid." };
    const request: SidebarApprovalRequest = {
      id,
      nonce: await sha256(`${id}:${createdAt}:nonce`),
      toolName,
      createdAt,
      expiresAt: createdAt + APPROVAL_TTL_MS,
      preview,
    };
    if (serializeApprovalRequest(request) === undefined) {
      return { request, approved: false, reason: "Approval preview exceeds the sidebar size limit." };
    }
    const decision = await requestApproval(request, ctx);
    if (decision.id !== request.id) return { request, approved: false, reason: "Approval ID was invalid." };
    if (!decision.approved) return { request, approved: false, reason: "Operation was rejected." };
    if (now() > request.expiresAt) return { request, approved: false, reason: "Approval expired." };
    return { request, approved: true };
  };

  const editBase = toolMetadata("edit", dependencies.baseTools?.edit);
  const writeBase = toolMetadata("write", dependencies.baseTools?.write);
  const bashBase = toolMetadata("bash", dependencies.baseTools?.bash);

  const edit: SidebarApprovalTool<EditToolInput> = {
    ...editBase,
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const queuePath = resolve(workspaceRoot, params.path);
      return mutationQueue(queuePath, async () => {
        try {
          const pathInfo = await inspectPath(params.path, workspaceRoot);
          const boundaryError = validatePath(pathInfo, workspaceRoot);
          if (boundaryError) return denied(boundaryError);
          if (!pathInfo.exists) return denied("Edit preview failed because the target does not exist.");
          await editOperations.access(pathInfo.absolutePath);
          const before = await editOperations.readFile(pathInfo.absolutePath);
          if (before.byteLength > MAX_PREVIEW_BYTES) return denied("Edit preview exceeds the sidebar size limit.");
          const afterText = applyEdits(before.toString("utf8"), params.edits);
          const after = Buffer.from(afterText);
          if (after.byteLength > MAX_PREVIEW_BYTES) return denied("Edit result exceeds the sidebar size limit.");
          const beforeSha256 = await sha256(before);
          const afterSha256 = await sha256(after);
          const diff = createDiff(pathInfo.canonicalPath, before.toString("utf8"), afterText);
          const approval = await approve("edit", {
            kind: "diff",
            path: pathInfo.canonicalPath,
            diff,
            beforeSha256,
            afterSha256,
          }, ctx);
          if (!approval.approved) return denied(approval.reason ?? "Operation denied.", approval.request.id);
          const currentInfo = await inspectPath(params.path, workspaceRoot);
          const currentBoundaryError = validatePath(currentInfo, workspaceRoot);
          if (currentBoundaryError || currentInfo.canonicalPath !== pathInfo.canonicalPath) {
            return denied("Target changed after preview; stale approval was discarded.", approval.request.id);
          }
          if (useSecureEditBoundary) {
            const postWriteSha256 = await secureWorkspaceWrite({
              workspaceRoot,
              targetPath: params.path,
              expectedCanonicalPath: pathInfo.canonicalPath,
              expectedExists: true,
              expectedSha256: beforeSha256,
              content: afterText,
              sha256,
            });
            return success("Edit applied.", { approvalId: approval.request.id, postWriteSha256, diff, patch: diff });
          }
          const current = await editOperations.readFile(pathInfo.absolutePath);
          if (await sha256(current) !== beforeSha256) return denied("Target changed after preview; stale approval was discarded.", approval.request.id);
          await editOperations.writeFile(pathInfo.absolutePath, afterText);
          const postWriteSha256 = await sha256(await editOperations.readFile(pathInfo.absolutePath));
          return success("Edit applied.", { approvalId: approval.request.id, postWriteSha256, diff, patch: diff });
        } catch (error) {
          return denied(`Edit preview failed: ${safeError(error)}`);
        }
      });
    },
  };

  const write: SidebarApprovalTool<WriteToolInput> = {
    ...writeBase,
    execute: async (_toolCallId, params, _signal, _onUpdate, ctx) => {
      const queuePath = resolve(workspaceRoot, params.path);
      return mutationQueue(queuePath, async () => {
        try {
          const pathInfo = await inspectPath(params.path, workspaceRoot);
          const boundaryError = validatePath(pathInfo, workspaceRoot);
          if (boundaryError) return denied(boundaryError);
          const before = pathInfo.exists ? await readFile(pathInfo.absolutePath) : Buffer.alloc(0);
          const after = Buffer.from(params.content);
          if (before.byteLength > MAX_PREVIEW_BYTES || after.byteLength > MAX_PREVIEW_BYTES) {
            return denied("Write preview exceeds the sidebar size limit.");
          }
          const beforeSha256 = await sha256(before);
          const afterSha256 = await sha256(after);
          const diff = createDiff(pathInfo.canonicalPath, before.toString("utf8"), params.content);
          const approval = await approve("write", {
            kind: "diff",
            path: pathInfo.canonicalPath,
            diff,
            beforeSha256,
            afterSha256,
          }, ctx);
          if (!approval.approved) return denied(approval.reason ?? "Operation denied.", approval.request.id);

          const currentInfo = await inspectPath(params.path, workspaceRoot);
          const currentBoundaryError = validatePath(currentInfo, workspaceRoot);
          if (currentBoundaryError || currentInfo.canonicalPath !== pathInfo.canonicalPath) {
            return denied("Target changed after preview; stale approval was discarded.", approval.request.id);
          }
          if (useSecureWriteBoundary) {
            const postWriteSha256 = await secureWorkspaceWrite({
              workspaceRoot,
              targetPath: params.path,
              expectedCanonicalPath: pathInfo.canonicalPath,
              expectedExists: pathInfo.exists,
              expectedSha256: beforeSha256,
              content: params.content,
              sha256,
            });
            return success("File written.", { approvalId: approval.request.id, postWriteSha256, diff, patch: diff });
          }
          const current = currentInfo.exists ? await readFile(currentInfo.absolutePath) : Buffer.alloc(0);
          if (await sha256(current) !== beforeSha256) return denied("Target changed after preview; stale approval was discarded.", approval.request.id);
          await writeOperations.mkdir(dirname(pathInfo.absolutePath));
          await writeOperations.writeFile(pathInfo.absolutePath, params.content);
          const postWriteSha256 = await sha256(await readFile(pathInfo.absolutePath));
          return success("File written.", { approvalId: approval.request.id, postWriteSha256, diff, patch: diff });
        } catch (error) {
          return denied(`Write preview failed: ${safeError(error)}`);
        }
      });
    },
  };

  const bash: SidebarApprovalTool<BashToolInput> = {
    ...bashBase,
    execute: async (_toolCallId, params, signal, onUpdate, ctx) => {
      if (
        typeof params.command !== "string" ||
        params.command.length === 0 ||
        params.command.includes("\0") ||
        Buffer.byteLength(params.command, "utf8") > MAX_GENERIC_INPUT_BYTES
      ) return denied("Bash command was invalid.");
      const approval = await approve("bash", { kind: "bash", command: params.command, cwd: workspaceRoot }, ctx);
      if (!approval.approved) return denied(approval.reason ?? "Operation denied.", approval.request.id);
      const chunks: Buffer[] = [];
      let byteCount = 0;
      const result = await bashOperations.exec(params.command, workspaceRoot, {
        signal,
        timeout: params.timeout,
        onData: (data) => {
          if (byteCount < MAX_BASH_OUTPUT_BYTES) {
            const remaining = MAX_BASH_OUTPUT_BYTES - byteCount;
            const chunk = data.subarray(0, remaining);
            chunks.push(chunk);
            byteCount += chunk.byteLength;
          }
          if (onUpdate) {
            void onUpdate({ content: [{ type: "text", text: Buffer.concat(chunks).toString("utf8") }], details: { approvalId: approval.request.id } });
          }
        },
      });
      const output = Buffer.concat(chunks).toString("utf8");
      return success(`${output}${result.exitCode === 0 ? "" : `\nProcess exited with code ${String(result.exitCode)}.`}`, { approvalId: approval.request.id });
    },
  };

  return { edit, write, bash };
}

export function registerSidebarApproval(
  pi: ExtensionAPI,
  dependencies: SidebarApprovalDependencies = {},
): void {
  const tools = createSidebarApprovalTools(dependencies);
  pi.registerTool(tools.edit as unknown as ToolDefinition);
  pi.registerTool(tools.write as unknown as ToolDefinition);
  pi.registerTool(tools.bash as unknown as ToolDefinition);

  let approvalPending = false;
  pi.on("tool_call", async (event, ctx) => {
    const guarded = event.toolName === "edit" || event.toolName === "write" || event.toolName === "bash";
    if (guarded) {
      const info = pi.getAllTools().find((tool) => tool.name === event.toolName);
      if (!info || !ownsGuardedTool(info.sourceInfo?.path)) {
        return { block: true, reason: "Guarded tool owner or provenance was replaced." };
      }
      return undefined;
    }

    if (isTrustedReadOnlyTool(event.toolName, pi)) return undefined;
    if (ctx.mode !== "rpc" || !ctx.hasUI) return { block: true, reason: "Sidebar approval UI is unavailable." };
    if (approvalPending) return { block: true, reason: "A nested approval is not permitted while another approval is pending." };

    const serialized = safeSerialize(event.input);
    if (!serialized) return { block: true, reason: "Tool input cannot be safely previewed." };
    const now = dependencies.now ?? Date.now;
    const createdAt = now();
    const id = (dependencies.randomUUID ?? createRandomUUID)();
    if (!isOpaqueId(id) || Buffer.byteLength(event.toolName, "utf8") > 256) {
      return { block: true, reason: "Generic tool identity cannot be safely approved." };
    }
    const request: SidebarApprovalRequest = {
      id,
      nonce: hashSha256(`${id}:${createdAt}:nonce`),
      toolName: event.toolName,
      createdAt,
      expiresAt: createdAt + APPROVAL_TTL_MS,
      preview: { kind: "generic", toolName: event.toolName, input: JSON.parse(serialized) as unknown },
    };
    const requestApproval = dependencies.requestApproval ?? requestHostApproval;
    approvalPending = true;
    try {
      const decision = await requestApproval(request, ctx);
      if (decision.id !== request.id || !decision.approved || now() > request.expiresAt) {
        return { block: true, reason: "Generic tool approval was rejected, invalid, or expired." };
      }
      return undefined;
    } catch {
      return { block: true, reason: "Generic tool approval failed closed." };
    } finally {
      approvalPending = false;
    }
  });
}

export default async function sidebarApproval(pi: ExtensionAPI): Promise<void> {
  if (process.env.CODEFLARE_SIDEBAR !== "1") return;
  const sdkPath = "file:///usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
  const sdk = await import(sdkPath);
  const workspaceRoot = WORKSPACE_ROOT;
  registerSidebarApproval(pi, {
    workspaceRoot,
    bashOperations: sdk.createLocalBashOperations(),
    withFileMutationQueue: sdk.withFileMutationQueue,
    baseTools: {
      edit: sdk.createEditTool(workspaceRoot) as unknown as ToolDefinition,
      write: sdk.createWriteTool(workspaceRoot) as unknown as ToolDefinition,
      bash: sdk.createBashTool(workspaceRoot) as unknown as ToolDefinition,
    },
  });
}

function toolMetadata(name: "edit" | "write" | "bash", base?: ToolDefinition): Omit<SidebarApprovalTool<never>, "execute"> {
  if (base) {
    const { execute: _execute, ...metadata } = base;
    return metadata as Omit<SidebarApprovalTool<never>, "execute">;
  }
  const parameters = name === "edit"
    ? { type: "object", properties: { path: { type: "string" }, edits: { type: "array" } }, required: ["path", "edits"], additionalProperties: false }
    : name === "write"
      ? { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"], additionalProperties: false }
      : { type: "object", properties: { command: { type: "string" }, timeout: { type: "number" } }, required: ["command"], additionalProperties: false };
  return {
    name,
    label: name[0]!.toUpperCase() + name.slice(1),
    description: `Codeflare sidebar guarded ${name} tool`,
    parameters: parameters as ToolDefinition["parameters"],
  } as Omit<SidebarApprovalTool<never>, "execute">;
}

function createMutationQueue(): MutationQueue {
  const tails = new Map<string, Promise<void>>();
  return async <T>(filePath: string, operation: () => Promise<T>): Promise<T> => {
    const previous = tails.get(filePath) ?? Promise.resolve();
    let release = (): void => {};
    const current = new Promise<void>((resolvePromise) => { release = resolvePromise; });
    const tail = previous.then(() => current);
    tails.set(filePath, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (tails.get(filePath) === tail) tails.delete(filePath);
    }
  };
}

function applyEdits(content: string, edits: EditToolInput["edits"]): string {
  let updated = content;
  for (const edit of edits) {
    if (edit.oldText.length === 0) throw new Error("empty edit match");
    const first = updated.indexOf(edit.oldText);
    if (first === -1 || updated.indexOf(edit.oldText, first + edit.oldText.length) !== -1) {
      throw new Error("edit match must be unique");
    }
    updated = `${updated.slice(0, first)}${edit.newText}${updated.slice(first + edit.oldText.length)}`;
  }
  return updated;
}

function createDiff(path: string, before: string, after: string): string {
  const removed = before.split("\n").filter((line, index, lines) => index < lines.length - 1 || line.length > 0).map((line) => `-${line}`);
  const added = after.split("\n").filter((line, index, lines) => index < lines.length - 1 || line.length > 0).map((line) => `+${line}`);
  return [`--- ${path}`, `+++ ${path}`, "@@", ...removed, ...added].join("\n");
}

function validatePath(info: SidebarPathInfo, workspaceRoot: string): string | undefined {
  if (info.symbolicLink) return "Symbolic link targets are not permitted.";
  if (info.safeAncestors === false) return "Target has a non-directory ancestor.";
  if (info.exists && info.regularFile === false) return "Target must be a regular file.";
  if (info.hardLinked) return "Hard-linked targets are not permitted.";
  const canonicalRoot = resolve(workspaceRoot);
  const rel = relative(canonicalRoot, info.canonicalPath);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    return "Target is outside the workspace.";
  }
  return undefined;
}

async function inspectLocalPath(path: string, cwd: string): Promise<SidebarPathInfo> {
  const lexicalRoot = resolve(cwd);
  const absolutePath = resolve(lexicalRoot, path);
  const lexicalRelative = relative(lexicalRoot, absolutePath);
  let symbolicLink = false;
  let safeAncestors = true;
  if (lexicalRelative !== "" && !lexicalRelative.startsWith("..") && !isAbsolute(lexicalRelative)) {
    const parts = lexicalRelative.split(/[\\/]+/);
    let cursor = lexicalRoot;
    for (let index = 0; index < parts.length; index += 1) {
      cursor = resolve(cursor, parts[index]!);
      try {
        const component = await lstat(cursor);
        if (component.isSymbolicLink()) symbolicLink = true;
        if (index < parts.length - 1 && !component.isDirectory()) safeAncestors = false;
      } catch (error) {
        if (isNodeError(error) && error.code === "ENOENT") break;
        throw error;
      }
    }
  }

  try {
    const target = await lstat(absolutePath);
    return {
      absolutePath,
      canonicalPath: await realpath(absolutePath),
      exists: true,
      symbolicLink: symbolicLink || target.isSymbolicLink(),
      regularFile: target.isFile(),
      hardLinked: target.nlink > 1,
      safeAncestors,
    };
  } catch (error) {
    if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    let existingParent = dirname(absolutePath);
    const missingParts = [absolutePath.slice(existingParent.length + 1)];
    while (true) {
      try {
        const canonicalParent = await realpath(existingParent);
        return {
          absolutePath,
          canonicalPath: resolve(canonicalParent, ...missingParts.reverse()),
          exists: false,
          symbolicLink,
          safeAncestors,
        };
      } catch (parentError) {
        if (!isNodeError(parentError) || parentError.code !== "ENOENT") throw parentError;
        const nextParent = dirname(existingParent);
        if (nextParent === existingParent) throw parentError;
        missingParts.push(existingParent.slice(nextParent.length + 1));
        existingParent = nextParent;
      }
    }
  }
}

interface SecureWriteRequest {
  workspaceRoot: string;
  targetPath: string;
  expectedCanonicalPath: string;
  expectedExists: boolean;
  expectedSha256: string;
  content: string;
  sha256(content: Buffer | string): Promise<string> | string;
}

async function secureWorkspaceWrite(request: SecureWriteRequest): Promise<string> {
  const lexicalRoot = resolve(request.workspaceRoot);
  const absoluteTarget = resolve(lexicalRoot, request.targetPath);
  const relativeTarget = relative(lexicalRoot, absoluteTarget);
  if (
    relativeTarget.length === 0 ||
    relativeTarget === ".." ||
    relativeTarget.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) ||
    isAbsolute(relativeTarget)
  ) throw new Error("Target is outside the workspace");

  const parts = relativeTarget.split(/[\\/]+/);
  const fileName = parts.pop();
  if (!fileName || fileName === "." || fileName === "..") throw new Error("Invalid target name");

  const canonicalRoot = await realpath(lexicalRoot);
  const directories: FileHandle[] = [];
  const createdDirectories: string[] = [];
  let target: FileHandle | undefined;
  let staged: FileHandle | undefined;
  let stagedPath: string | undefined;
  let mutationCompleted = false;
  try {
    let directory = await open(
      lexicalRoot,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    directories.push(directory);
    if (await realpath(`/proc/self/fd/${directory.fd}`) !== canonicalRoot) {
      throw new Error("Workspace identity changed");
    }

    for (const part of parts) {
      if (!part || part === "." || part === "..") throw new Error("Invalid target path");
      const childPath = `/proc/self/fd/${directory.fd}/${part}`;
      let child: FileHandle;
      try {
        child = await open(
          childPath,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
      } catch (error) {
        if (request.expectedExists || !isNodeError(error) || error.code !== "ENOENT") throw error;
        try {
          await mkdir(childPath, { mode: 0o700 });
          createdDirectories.push(childPath);
        } catch (mkdirError) {
          if (!isNodeError(mkdirError) || mkdirError.code !== "EEXIST") throw mkdirError;
        }
        child = await open(
          childPath,
          constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
        );
      }
      const childStat = await child.stat();
      if (!childStat.isDirectory()) {
        await child.close();
        throw new Error("Target ancestor is not a directory");
      }
      directories.push(child);
      directory = child;
      assertCanonicalWorkspacePath(await realpath(`/proc/self/fd/${child.fd}`), canonicalRoot);
    }

    const canonicalParent = await realpath(`/proc/self/fd/${directory.fd}`);
    assertCanonicalWorkspacePath(canonicalParent, canonicalRoot);
    if (resolve(canonicalParent) !== resolve(dirname(request.expectedCanonicalPath))) {
      throw new Error("Target parent changed after preview");
    }

    const fdTargetPath = `/proc/self/fd/${directory.fd}/${fileName}`;
    let targetIdentity: { dev: number; ino: number; mode: number } | undefined;
    let before = Buffer.alloc(0);
    if (request.expectedExists) {
      target = await open(fdTargetPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      const targetStat = await target.stat();
      if (!targetStat.isFile() || targetStat.nlink !== 1 || targetStat.size > MAX_PREVIEW_BYTES) {
        throw new Error("Unsafe target identity");
      }
      const canonicalTarget = await realpath(`/proc/self/fd/${target.fd}`);
      assertCanonicalWorkspacePath(canonicalTarget, canonicalRoot);
      if (resolve(canonicalTarget) !== resolve(request.expectedCanonicalPath)) {
        throw new Error("Target changed after preview");
      }
      targetIdentity = { dev: targetStat.dev, ino: targetStat.ino, mode: targetStat.mode & 0o777 };
      before = await target.readFile();
    } else {
      await assertPathMissing(fdTargetPath);
    }
    if (await request.sha256(before) !== request.expectedSha256) {
      throw new Error("Target changed after preview");
    }

    const content = Buffer.from(request.content);
    stagedPath = `/proc/self/fd/${directory.fd}/.codeflare-${fileName}-${createRandomUUID()}.tmp`;
    staged = await open(
      stagedPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      targetIdentity?.mode ?? 0o600,
    );
    let offset = 0;
    while (offset < content.byteLength) {
      const written = await staged.write(content, offset, content.byteLength - offset, offset);
      if (written.bytesWritten <= 0) throw new Error("Target write made no progress");
      offset += written.bytesWritten;
    }
    await staged.sync();
    await staged.close();
    staged = undefined;

    const commitParent = await realpath(`/proc/self/fd/${directory.fd}`);
    if (resolve(commitParent) !== resolve(dirname(request.expectedCanonicalPath))) {
      throw new Error("Target parent changed during mutation");
    }
    if (targetIdentity && target) {
      const currentContent = await readLocalFile(`/proc/self/fd/${target.fd}`);
      if (await request.sha256(currentContent) !== request.expectedSha256) {
        throw new Error("Target changed during mutation");
      }
      const current = await lstat(fdTargetPath);
      if (current.dev !== targetIdentity.dev || current.ino !== targetIdentity.ino || current.isSymbolicLink()) {
        throw new Error("Target changed during mutation");
      }
    } else {
      await assertPathMissing(fdTargetPath);
    }

    await rename(stagedPath, fdTargetPath);
    stagedPath = undefined;
    mutationCompleted = true;
    await directory.sync().catch(() => undefined);
    const finalStat = await lstat(fdTargetPath);
    if (!finalStat.isFile() || finalStat.nlink !== 1) throw new Error("Unsafe final target identity");
    const finalCanonicalTarget = await realpath(fdTargetPath);
    if (resolve(finalCanonicalTarget) !== resolve(request.expectedCanonicalPath)) {
      throw new Error("Target changed during mutation");
    }
    return request.sha256(content);
  } finally {
    await staged?.close().catch(() => undefined);
    await target?.close().catch(() => undefined);
    if (stagedPath && !mutationCompleted) await rm(stagedPath, { force: true }).catch(() => undefined);
    if (!mutationCompleted) {
      for (const directoryPath of createdDirectories.reverse()) {
        await rmdir(directoryPath).catch(() => undefined);
      }
    }
    for (const directory of directories.reverse()) {
      await directory.close().catch(() => undefined);
    }
  }
}

async function assertPathMissing(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error("Target changed after preview");
}

function assertCanonicalWorkspacePath(path: string, canonicalRoot: string): void {
  if (path.endsWith(" (deleted)")) throw new Error("Workspace path was removed");
  const rel = relative(canonicalRoot, path);
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error("Target is outside the workspace");
  }
}

const localEditOperations: EditOperations = {
  access: async (path) => access(path, constants.R_OK | constants.W_OK),
  readFile: readLocalFile,
  writeFile: async (path, content) => writeLocalFile(path, content),
};

const localWriteOperations: WriteOperations = {
  mkdir: async (path) => { await mkdir(path, { recursive: true }); },
  writeFile: async (path, content) => writeLocalFile(path, content),
};

const localBashOperations: BashOperations = {
  exec: async (command, cwd, options) => new Promise((resolvePromise, reject) => {
    const child = spawn("/bin/bash", ["-lc", command], {
      cwd,
      env: options.env ?? process.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", options.onData);
    child.stderr.on("data", options.onData);
    child.once("error", reject);
    child.once("close", (exitCode) => resolvePromise({ exitCode }));
    const abort = (): void => { child.kill("SIGTERM"); };
    options.signal?.addEventListener("abort", abort, { once: true });
    let timer: NodeJS.Timeout | undefined;
    if (options.timeout && options.timeout > 0) timer = setTimeout(abort, options.timeout * 1000);
    child.once("close", () => {
      options.signal?.removeEventListener("abort", abort);
      if (timer) clearTimeout(timer);
    });
  }),
};

async function requestHostApproval(
  request: SidebarApprovalRequest,
  ctx: ExtensionContext,
): Promise<SidebarApprovalDecision> {
  if (!isOpaqueId(request.id)) throw new Error("Invalid approval ID");
  await mkdir(MANIFEST_ROOT, { recursive: true, mode: 0o700 });
  const rootInfo = await lstat(MANIFEST_ROOT);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || await realpath(MANIFEST_ROOT) !== MANIFEST_ROOT) {
    throw new Error("Unsafe approval manifest root");
  }
  await chmod(MANIFEST_ROOT, 0o700);
  const manifestPath = resolve(MANIFEST_ROOT, `${request.id}.json`);
  const serialized = serializeApprovalRequest(request);
  if (serialized === undefined) throw new Error("Approval preview exceeds the sidebar size limit");
  const handle = await open(manifestPath, "wx", 0o600);
  try {
    await handle.chmod(0o600);
    await handle.writeFile(serialized, { encoding: "utf8" });
  } finally {
    await handle.close();
  }
  try {
    const approved = await ctx.ui.confirm(
      "Approve guarded operation",
      `${request.id}:${hashSha256(serialized)}`,
    );
    return { id: request.id, approved };
  } finally {
    await rm(manifestPath, { force: true });
  }
}

function isTrustedReadOnlyTool(toolName: string, pi: ExtensionAPI): boolean {
  if (!["read", "grep", "find", "ls"].includes(toolName)) return false;
  const info = pi.getAllTools().find((tool) => tool.name === toolName);
  if (!info) return false;
  return info.sourceInfo?.source === "builtin" && info.sourceInfo.path === `<builtin:${toolName}>`;
}

function ownsGuardedTool(path: string | undefined): boolean {
  return typeof path === "string" && (path === SIDEBAR_APPROVAL_SOURCE || path.endsWith(`/${SIDEBAR_APPROVAL_SOURCE}`));
}

function serializeApprovalRequest(request: SidebarApprovalRequest): string | undefined {
  try {
    const serialized = `${JSON.stringify(request)}\n`;
    return Buffer.byteLength(serialized, "utf8") <= MAX_APPROVAL_MANIFEST_BYTES ? serialized : undefined;
  } catch {
    return undefined;
  }
}

function safeSerialize(value: unknown): string | undefined {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined || Buffer.byteLength(serialized) > MAX_GENERIC_INPUT_BYTES) return undefined;
    return serialized;
  } catch {
    return undefined;
  }
}

function hashSha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function isOpaqueId(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function emptyRequest(toolName: string, preview: SidebarApprovalPreview): SidebarApprovalRequest {
  return { id: "unavailable", nonce: "unavailable", toolName, createdAt: 0, expiresAt: 0, preview };
}

function denied(reason: string, approvalId?: string): AgentToolResult<SidebarApprovalDetails> {
  const details: SidebarApprovalDetails = approvalId ? { denied: reason, approvalId } : { denied: reason };
  return { content: [{ type: "text", text: reason }], details };
}

function success(text: string, details: SidebarApprovalDetails): AgentToolResult<SidebarApprovalDetails> {
  return { content: [{ type: "text", text }], details };
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 256) : "operation failed";
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
