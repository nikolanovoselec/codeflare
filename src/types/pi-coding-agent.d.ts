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
    [key: string]: any;
  }

  export type ExtensionCommandContext = ExtensionContext;

  export interface ExtensionAPI {
    registerCommand(
      name: string,
      config: {
        description: string;
        getArgumentCompletions?: (prefix: string) => any;
        handler: (args: string, ctx: ExtensionCommandContext) => void | Promise<void>;
      },
    ): void;
    [key: string]: any;
  }
}
