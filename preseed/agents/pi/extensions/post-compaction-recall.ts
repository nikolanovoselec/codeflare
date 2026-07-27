/**
 * Post-compaction recall for Pi (REQ-MEM-019).
 *
 * Compaction replaces the conversation with a summary and keeps the session, so
 * the first-prompt memory injection - already spent for this session - never
 * fires again and the agent continues from a summary of a summary. This
 * extension covers exactly that boundary: on `session_compact` it delivers the
 * Context and Decisions sections of the most recent session extracts as a
 * custom message, which persists in the session and so stays in context for the
 * rest of it. The Claude runtime does the same through a SessionStart hook
 * under matcher `compact`.
 *
 * Fail-safe: any error leaves the session untouched. Recall is a convenience,
 * never a gate.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isChildSessionFirstLine, isChildSessionHeader } from "./memory-vault-helpers";
import {
  orderByCaptureInstant,
  recallBlock,
  recallMessage,
  RECALL_EXTRACT_COUNT,
  RECALL_PER_FILE_BYTES,
} from "./post-compaction-recall-helpers";

const USER_HOME = "/home/user";
const SESSIONS_DIR = join(USER_HOME, "Vault", "Raw", "Sessions");

export const POST_COMPACTION_RECALL_TYPE = "post-compaction-recall";

export interface PostCompactionRecallPi {
  on(event: string, handler: (event: any, ctx: any) => void | Promise<void>): void;
  sendMessage(
    message: {
      customType: string;
      content: string;
      display: boolean;
      details?: unknown;
    },
    options: { deliverAs: "followUp"; triggerTurn: boolean },
  ): void;
}

export interface PostCompactionRecallDependencies {
  sessionsDir: string;
  extractCount: number;
  perFileBytes: number;
}

const defaultDependencies: PostCompactionRecallDependencies = {
  sessionsDir: SESSIONS_DIR,
  extractCount: RECALL_EXTRACT_COUNT,
  perFileBytes: RECALL_PER_FILE_BYTES,
};

// Same shape memory-vault.ts uses: the live header when the runtime has one, the
// persisted first line otherwise. A subagent compacting its own narrow context
// must not be handed five whole-session digests.
function isChildSession(ctx: any): boolean {
  try {
    const header = ctx?.sessionManager?.getHeader?.();
    if (header) return isChildSessionHeader(header);
  } catch { /* fall through to persisted header */ }
  try {
    const sessionFile = ctx?.sessionManager?.getSessionFile?.();
    if (!sessionFile || !existsSync(sessionFile)) return false;
    return isChildSessionFirstLine(readFileSync(sessionFile, "utf8").split("\n", 1)[0]);
  } catch {
    return false;
  }
}

export function buildRecall(dependencies: PostCompactionRecallDependencies): string | null {
  const { sessionsDir, extractCount, perFileBytes } = dependencies;
  let names: string[];
  try {
    names = readdirSync(sessionsDir).filter((name) => name.endsWith(".md"));
  } catch {
    return null;
  }

  const blocks: string[] = [];
  for (const name of orderByCaptureInstant(names).slice(0, extractCount)) {
    const path = join(sessionsDir, name);
    let text: string;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const block = recallBlock(path, text, perFileBytes);
    if (block) blocks.push(block);
  }
  return recallMessage(blocks, sessionsDir);
}

export function registerPostCompactionRecall(
  pi: PostCompactionRecallPi,
  dependencies: PostCompactionRecallDependencies,
): void {
  pi.on("session_compact", (_event, ctx) => {
    if (isChildSession(ctx)) return;
    const content = buildRecall(dependencies);
    if (!content) return;
    // followUp without triggerTurn: the recall rides along with whatever runs
    // next - the retried turn on overflow recovery, or the user's next prompt -
    // rather than spending a turn announcing itself. display stays off because
    // this is context for the model, not a notice for the user.
    pi.sendMessage(
      { customType: POST_COMPACTION_RECALL_TYPE, content, display: false, details: { sessionsDir: dependencies.sessionsDir } },
      { deliverAs: "followUp", triggerTurn: false },
    );
  });
}

export default function postCompactionRecall(pi: ExtensionAPI): void {
  registerPostCompactionRecall(pi as unknown as PostCompactionRecallPi, defaultDependencies);
}
