import { execFileSync } from "node:child_process";
import { isAbsolute } from "node:path";

const CODEFLARE_SESSION_ID = /^[a-z0-9]{8,24}$/;
const PI_SESSION_ID = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,126}[A-Za-z0-9])?$/;

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

  execFileSync(process.execPath, [env.TRANSCRIPT_RETENTION_SCRIPT || "/transcript-retention.mjs",
    "commit-classic-pi", home, codeflareSessionId, nativeSessionId, sessionFile], {
    env: { ...process.env, CODEFLARE_RUNTIME_ROOT: env.CODEFLARE_RUNTIME_ROOT ?? "/run/codeflare" },
    stdio: "pipe",
  });
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
