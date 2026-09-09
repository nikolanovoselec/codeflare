import {
  closeSync,
  mkdirSync,
  openSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

const CODEFLARE_SESSION_ID = /^[a-z0-9]{8,24}$/;
const NATIVE_SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const HEADER_LIMIT = 16 * 1024;

type SessionStartEvent = { reason?: unknown };
type SessionContext = {
  sessionManager: { getSessionFile(): string | undefined };
  ui: { notify(message: string, level?: "warning"): void };
};
type ExtensionAPI = {
  on(event: "session_start", handler: (event: SessionStartEvent, ctx: SessionContext) => void): void;
};
type RuntimeEnvironment = Record<string, string | undefined>;

function readSessionId(path: string): string | undefined {
  const descriptor = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(HEADER_LIMIT);
    const length = readSync(descriptor, buffer, 0, buffer.length, 0);
    const firstLineEnd = buffer.indexOf(0x0a, 0);
    if (length === 0 || firstLineEnd < 0 || firstLineEnd >= length) return undefined;
    const header = JSON.parse(buffer.subarray(0, firstLineEnd).toString("utf8")) as {
      type?: unknown;
      version?: unknown;
      id?: unknown;
    };
    if (header.type !== "session" || header.version !== 3 || typeof header.id !== "string") return undefined;
    return NATIVE_SESSION_ID.test(header.id) ? header.id : undefined;
  } catch {
    return undefined;
  } finally {
    closeSync(descriptor);
  }
}

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
  if (!home || !codeflareSessionId || !CODEFLARE_SESSION_ID.test(codeflareSessionId) || !sessionFile || !isAbsolute(sessionFile)) {
    return false;
  }

  const sessionRoot = realpathSync(resolve(home, ".pi", "agent", "sessions"));
  const canonicalSessionFile = realpathSync(sessionFile);
  const sessionRelative = relative(sessionRoot, canonicalSessionFile);
  const parts = sessionRelative.split(sep);
  if (sessionRelative.startsWith(`..${sep}`) || isAbsolute(sessionRelative) || parts.length !== 2) return false;
  if (!parts[0].startsWith("--") || !parts[0].endsWith("--")) return false;

  const nativeSessionId = readSessionId(canonicalSessionFile);
  if (!nativeSessionId || !basename(canonicalSessionFile).endsWith(`_${nativeSessionId}.jsonl`)) return false;

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
