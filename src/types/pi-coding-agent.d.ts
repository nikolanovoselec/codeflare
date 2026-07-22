// Ambient declaration for the container-only Pi coding-agent SDK.
//
// The Pi extensions under preseed/agents/pi/extensions/ are reached by the root
// `tsc --noEmit` because src tests import their pure helpers (e.g.
// src/__tests__/lib/review-command.test.ts imports renderReviewStatus from
// review-command.ts, which pulls in review-jobs.ts). The SDK
// (`@earendil-works/pi-coding-agent`) is installed only in the container and
// ships no type declarations, so tsc reports TS2307. Runtime resolution in the
// Workers pool is unaffected — this only supplies types for the typecheck.
//
// Only the surface the reached extensions use is modelled. Members are loosely
// typed (the real SDK is far richer); the command-handler signature IS typed so
// the handler parameters are contextually typed and noImplicitAny is satisfied.
declare module "@earendil-works/pi-coding-agent" {
  export function getAgentDir(): string;

  export type NotifyLevel = "info" | "warning" | "error";

  export interface ExtensionContext {
    cwd: string;
    hasUI: boolean;
    mode: string;
    ui: {
      confirm(title: string, message: string, options?: unknown): Promise<boolean>;
      [key: string]: any;
    };
    [key: string]: any;
  }

  export type ExtensionCommandContext = ExtensionContext;

  export interface AgentToolResult<T> {
    content: Array<{ type: "text"; text: string } | { type: "image"; [key: string]: any }>;
    details: T;
  }

  export type AgentToolUpdateCallback<T> = (result: AgentToolResult<T>) => void | Promise<void>;

  export interface EditToolInput {
    path: string;
    edits: Array<{ oldText: string; newText: string }>;
  }

  export interface WriteToolInput {
    path: string;
    content: string;
  }

  export interface BashToolInput {
    command: string;
    timeout?: number;
  }

  export interface EditOperations {
    access(path: string): Promise<void>;
    readFile(path: string): Promise<Buffer>;
    writeFile(path: string, content: string): Promise<void>;
  }

  export interface WriteOperations {
    mkdir(path: string): Promise<void>;
    writeFile(path: string, content: string): Promise<void>;
  }

  export interface BashOperations {
    exec(command: string, cwd: string, options: {
      onData(data: Buffer): void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    }): Promise<{ exitCode: number | null }>;
  }

  export interface ToolDefinition {
    name: string;
    label: string;
    description: string;
    parameters: any;
    execute(...args: any[]): Promise<AgentToolResult<any>>;
    [key: string]: any;
  }

  export interface ExtensionAPI {
    registerCommand(
      name: string,
      config: {
        description: string;
        getArgumentCompletions?: (prefix: string) => any;
        handler: (args: string, ctx: ExtensionCommandContext) => void | Promise<void>;
      },
    ): void;
    registerTool(tool: ToolDefinition): void;
    on(event: string, handler: (event: any, ctx: ExtensionContext) => any): void;
    getAllTools(): Array<{
      name: string;
      sourceInfo?: { path: string; source: string; [key: string]: any };
      [key: string]: any;
    }>;
    [key: string]: any;
  }
}
