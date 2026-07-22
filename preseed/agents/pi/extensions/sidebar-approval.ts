import {
  createBashTool,
  createEditTool,
  createWriteTool,
  withFileMutationQueue,
  type AgentToolResult,
  type AgentToolUpdateCallback,
  type BashOperations,
  type BashToolInput,
  type EditOperations,
  type EditToolInput,
  type ExtensionAPI,
  type ExtensionContext,
  type ToolDefinition,
  type WriteOperations,
  type WriteToolInput,
} from "@earendil-works/pi-coding-agent";

export const SIDEBAR_APPROVAL_NOT_IMPLEMENTED = "NOT_IMPLEMENTED: Pi sidebar approval";
export const SIDEBAR_APPROVAL_SOURCE = "extensions/sidebar-approval.ts";

export type SidebarApprovalPreview =
  | { kind: "diff"; path: string; diff: string; beforeSha256: string; afterSha256: string }
  | { kind: "bash"; command: string; cwd: string }
  | { kind: "generic"; toolName: string; input: unknown };

export interface SidebarApprovalRequest {
  id: string;
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
}

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
  withFileMutationQueue?: typeof withFileMutationQueue;
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

async function notImplemented(): Promise<never> {
  throw new Error(SIDEBAR_APPROVAL_NOT_IMPLEMENTED);
}

export function createSidebarApprovalTools(
  dependencies: SidebarApprovalDependencies = {},
): SidebarApprovalTools {
  const cwd = dependencies.workspaceRoot ?? "/home/user/workspace";
  const edit = createEditTool(cwd, dependencies.editOperations ? { operations: dependencies.editOperations } : undefined);
  const write = createWriteTool(cwd, dependencies.writeOperations ? { operations: dependencies.writeOperations } : undefined);
  const bash = createBashTool(cwd, dependencies.bashOperations ? { operations: dependencies.bashOperations } : undefined);

  return {
    edit: { ...edit, execute: notImplemented } as unknown as SidebarApprovalTool<EditToolInput>,
    write: { ...write, execute: notImplemented } as unknown as SidebarApprovalTool<WriteToolInput>,
    bash: { ...bash, execute: notImplemented } as unknown as SidebarApprovalTool<BashToolInput>,
  };
}

export function registerSidebarApproval(
  pi: ExtensionAPI,
  dependencies: SidebarApprovalDependencies = {},
): void {
  const tools = createSidebarApprovalTools(dependencies);
  pi.registerTool(tools.edit as unknown as ToolDefinition);
  pi.registerTool(tools.write as unknown as ToolDefinition);
  pi.registerTool(tools.bash as unknown as ToolDefinition);
  pi.on("tool_call", notImplemented);
}

export default function sidebarApproval(_pi: ExtensionAPI): void {
  // Intentionally inert until the guarded approval behavior is implemented.
}
