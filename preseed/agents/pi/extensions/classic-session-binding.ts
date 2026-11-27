import {
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

const CODEFLARE_SESSION_ID = /^[a-z0-9]{8,24}$/;
const PI_SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

type SessionStartEvent = { reason?: unknown };
type SessionContext = {
  sessionManager: {
    getSessionFile(): string | undefined;
    getSessionId(): string;
  };
  ui: { notify(message: string, level?: "warning"): void };
};
type ExtensionAPI = {
  on(event: "session_start", handler: (event: SessionStartEvent, ctx: SessionContext) => void): void;
};
type RuntimeEnvironment = Record<string, string | undefined>;

export function adoptClassicResumedSession(
  event: SessionStartEvent,
  ctx: SessionContext,
  env: RuntimeEnvironment = process.env,
): boolean {
  if (
    event.reason !== "resume"
    || env.CODEFLARE_TERMINAL_MODE !== "classic"
    || env.TERMINAL_ID !== "1"
    || env.MANUAL_TAB
  ) return false;

  const home = env.HOME;
  const codeflareSessionId = env.SESSION_ID;
  const sessionFile = ctx.sessionManager.getSessionFile();
  const nativeSessionId = ctx.sessionManager.getSessionId();
  if (
    !home
    || !codeflareSessionId
    || !CODEFLARE_SESSION_ID.test(codeflareSessionId)
    || !sessionFile
    || !isAbsolute(sessionFile)
    || !PI_SESSION_ID.test(nativeSessionId)
  ) return false;

  const sessionRoot = realpathSync(resolve(home, ".pi", "agent", "sessions"));
  const canonicalSessionFile = realpathSync(sessionFile);
  const sessionRelative = relative(sessionRoot, canonicalSessionFile);
  const parts = sessionRelative.split(sep);
  if (sessionRelative.startsWith(`..${sep}`) || isAbsolute(sessionRelative) || parts.length !== 2) return false;
  if (!parts[0].startsWith("--") || !parts[0].endsWith("--")) return false;
  if (!basename(canonicalSessionFile).endsWith(`_${nativeSessionId}.jsonl`)) return false;

  const bindingDirectory = join(home, ".codeflare", "classic", "sessions", `cf-${codeflareSessionId}`);
  const bindingFile = join(bindingDirectory, "agent-session-id");
  mkdirSync(bindingDirectory, { recursive: true, mode: 0o700 });
  const temporary = join(bindingDirectory, `.agent-session-id.${process.pid}.${randomUUID()}`);
  try {
    writeFileSync(temporary, `${nativeSessionId}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
    renameSync(temporary, bindingFile);
  } finally {
    rmSync(temporary, { force: true });
  }
  return true;
}

export default function registerClassicSessionBinding(
  pi: ExtensionAPI,
  env: RuntimeEnvironment = process.env,
): void {
  pi.on("session_start", (event, ctx) => {
    try {
      adoptClassicResumedSession(event, ctx, env);
    } catch {
      ctx.ui.notify("Codeflare could not preserve the selected Classic Pi transcript for the next restart.", "warning");
    }
  });
}
