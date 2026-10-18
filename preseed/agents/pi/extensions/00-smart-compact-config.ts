import { randomUUID } from "node:crypto";
import {
  closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync,
  openSync, readFileSync, renameSync, rmdirSync, unlinkSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

// REQ-AGENT-076 AC8: inherit the active provider/model and the built-in
// Thorough 10k/30k budgets. Explicit user choices always take precedence.
const defaults = {
  mode: "thorough",
  compactionEngines: ["eesv"],
  summaryModel: null,
  segmentationModel: null,
  verificationModel: null,
  summaryThinkingLevel: "low",
  autoTrigger: true,
  autoTriggerStrategy: "native-hook",
  minContextPercent: 0,
  maxContextTokens: 272000,
  maxLlmCalls: 4,
  maxLatencyMs: 120000,
  autoTriggerTimeoutMs: 120000,
  requireApproval: true,
  backupEnabled: true,
  zeroCallEnabled: false,
  contextGraphEnabled: false,
  contextHygieneEnabled: false,
  contextNavigationEnabled: false,
  contextRecallEnabled: false,
  contextPivotEnabled: false,
  contextAnchorCacheEnabled: false,
  contextAnchorStatusEnabled: false,
  contextGuidanceEnabled: false,
  promptCacheRoutingEnabled: false,
  onlineDamageMonitor: true,
  agentToolAccess: "disabled",
  toolLoading: "off",
  showStatus: false,
};

function stat(path: string) {
  try { return lstatSync(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function configureSmartCompact(agentDir: string): boolean {
  const settingsPath = join(agentDir, "settings.json");
  const lockPath = `${settingsPath}.lock`;
  let locked = false;
  let temporaryPath: string | undefined;
  let output: number | undefined;
  try {
    if (!isAbsolute(agentDir)) return false;
    // Do not follow a symlink in the directory chain or at settings.json.
    for (let path = resolve(agentDir); ; path = dirname(path)) {
      const info = stat(path);
      if (info && !info.isDirectory()) return false;
      if (dirname(path) === path) break;
    }
    mkdirSync(resolve(agentDir), { recursive: true, mode: 0o700 });
    // Pi/package writers use this lock directory. Never steal an occupied lock,
    // including a regular file or symlink, and never remove a lock we did not take.
    mkdirSync(lockPath, { mode: 0o700 });
    locked = true;

    const previous = stat(settingsPath);
    let settings: unknown = {};
    if (previous) {
      if (!previous.isFile()) return false;
      const input = openSync(settingsPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try {
        const opened = fstatSync(input);
        if (!opened.isFile() || opened.dev !== previous.dev || opened.ino !== previous.ino) return false;
        settings = JSON.parse(readFileSync(input, "utf8"));
      } finally { closeSync(input); }
    }
    if (!isObject(settings)) return false;
    const existing = Object.hasOwn(settings, "smartCompact") ? settings.smartCompact : {};
    if (!isObject(existing)) return false;
    if (Object.keys(defaults).every(key => Object.hasOwn(existing, key))) return true;
    settings.smartCompact = { ...defaults, ...existing };

    const mode = previous ? previous.mode & 0o777 : 0o600;
    const candidate = join(agentDir, `.settings.json.${randomUUID()}.tmp`);
    output = openSync(candidate, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
    temporaryPath = candidate;
    writeFileSync(output, `${JSON.stringify(settings, null, 2)}\n`);
    fchmodSync(output, mode);
    fsyncSync(output);
    closeSync(output);
    output = undefined;

    // Refuse a target changed by a non-cooperating writer while we held the lock.
    const current = stat(settingsPath);
    if (previous ? !current || !current.isFile() || current.dev !== previous.dev
      || current.ino !== previous.ino || current.size !== previous.size
      || current.mtimeMs !== previous.mtimeMs || current.ctimeMs !== previous.ctimeMs : current) return false;
    renameSync(temporaryPath, settingsPath);
    temporaryPath = undefined;
    return true;
  } catch {
    // Settings may contain credentials; never log contents or parse errors.
    return false;
  } finally {
    if (output !== undefined) try { closeSync(output); } catch { /* Already closed. */ }
    if (temporaryPath) try { unlinkSync(temporaryPath); } catch { /* Preserve the original on failure. */ }
    if (locked) try { rmdirSync(lockPath); } catch { /* Do not remove anything placed inside the lock. */ }
  }
}

export default function smartCompactConfig(_pi: unknown): void {
  configureSmartCompact(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"));
}
