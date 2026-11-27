import { randomUUID } from "node:crypto";
import {
	closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, renameSync, rmSync, writeFileSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { EditorComponent, TUI } from "@earendil-works/pi-tui";

// REQ-AGENT-272: this reports native evidence, not ownership. Host admits work,
// closes stock sessiond sessions and verifies the terminal process really exited.
type Surface = "chat" | "terminal";
type Binding = { id: string; cwd: string; path: string };
type Owner = {
	generation: number;
	surface: Surface | null;
	phase: "active" | "waiting" | "stopping" | "releasing" | "opening" | "complete" | "failed" | "uncertain" | "cancelled";
	target?: Surface;
	requestId?: string;
	binding?: Binding;
	terminalTicket?: string;
};

const ticketPattern = /^[A-Za-z0-9_-]{1,128}$/;
const nativeIdPattern = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,126}[A-Za-z0-9])?$/;
const phases = new Set(["active", "waiting", "stopping", "releasing", "opening", "complete", "failed", "uncertain", "cancelled"]);
const runtime = process.env.CODEFLARE_RUNTIME_ROOT || "/run/codeflare";
const stateDir = join(runtime, "pi-web");
const ownerPath = join(stateDir, "owner.json");
const hasCode = (error: unknown, code: string) => (error as NodeJS.ErrnoException)?.code === code;
const matchesBinding = (left: Binding | undefined, right: Binding) =>
	left?.id === right.id && left?.cwd === right.cwd && left?.path === right.path;

function readOwner(generation: number): Owner | undefined | null {
	try {
		const value = JSON.parse(readFileSync(ownerPath, "utf8")) as Owner;
		if (!value || value.generation !== generation || !phases.has(value.phase) ||
			(value.surface !== "terminal" && value.surface !== "chat" && value.surface !== null) ||
			(value.target !== undefined && value.target !== "terminal" && value.target !== "chat") ||
			(value.requestId !== undefined && (typeof value.requestId !== "string" || !value.requestId)) ||
			(value.terminalTicket !== undefined && (typeof value.terminalTicket !== "string" || !ticketPattern.test(value.terminalTicket))) ||
			(value.binding !== undefined && (!value.binding ||
				![value.binding.id, value.binding.cwd, value.binding.path].every((part) => typeof part === "string" && part.length > 0)))) {
			return null;
		}
		return value;
	} catch (error) {
		if (!hasCode(error, "ENOENT")) return null;
		// A dangling link is not absent state and cannot grant the initial ticket.
		try { lstatSync(ownerPath); } catch (statError) { if (hasCode(statError, "ENOENT")) return undefined; }
		return null;
	}
}

function processStartTime(): string | undefined {
	try {
		const stat = readFileSync("/proc/self/stat", "utf8");
		const start = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
		return start && /^[0-9]+$/.test(start) ? start : undefined;
	} catch { return; }
}

function atomicWrite(path: string, value: string) {
	const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		writeFileSync(temp, value, { mode: 0o600, flag: "wx" });
		renameSync(temp, path);
	} finally {
		rmSync(temp, { force: true });
	}
}

function readFileEdge(fd: number, length: number, offset: number): string {
	const buffer = Buffer.alloc(length);
	const count = readSync(fd, buffer, 0, length, offset);
	return buffer.subarray(0, count).toString("utf8");
}

function verifyDiskHeader(fd: number, size: number, binding: Binding) {
	const head = readFileEdge(fd, Math.min(size, 65536), 0);
	const newline = head.indexOf("\n");
	if (newline < 0) throw new Error("Unterminated Pi session header");
	const header = JSON.parse(head.slice(0, newline));
	if (header.type !== "session" || header.id !== binding.id || header.cwd !== binding.cwd) {
		throw new Error("Pi session header no longer matches the binding");
	}
}

// Compare the native header and the last physical entry that an unmodified Pi
// will use as its leaf. Bound the reads; unreadable or ambiguous files cannot
// be released. This is only needed on the final idle boundary, not every poll.
function diskLeaf(binding: Binding): string | null {
	const fd = openSync(binding.path, "r");
	try {
		const stat = fstatSync(fd);
		verifyDiskHeader(fd, stat.size, binding);
		const offset = Math.max(0, stat.size - 1_048_576);
		const tail = readFileEdge(fd, stat.size - offset, offset).trimEnd();
		const lineStart = tail.lastIndexOf("\n");
		if (offset && lineStart < 0) throw new Error("Pi session leaf is too large to verify");
		const entry = JSON.parse(tail.slice(lineStart + 1));
		if (!offset && lineStart < 0 && entry.type === "session") return null;
		if (typeof entry.id !== "string" || entry.type === "session") throw new Error("Invalid Pi session leaf");
		return entry.id;
	} finally {
		closeSync(fd);
	}
}

// Both the image-owned path and the daemon's discovery symlink can be loaded by
// Pi. Claim once per SessionManager even if its loader evaluates both paths.
const claimsKey = Symbol.for("codeflare.pi-web.session-managers");
const globalClaims = globalThis as typeof globalThis & { [claimsKey]?: WeakSet<object> };
const claims = globalClaims[claimsKey] ??= new WeakSet<object>();

export default function (pi: ExtensionAPI) {
	const generation = Number(process.env.CODEFLARE_PI_GENERATION);
	const ticket = process.env.CODEFLARE_PI_TERMINAL_TICKET;
	const terminal = process.env.CODEFLARE_PI_TERMINAL_PID === String(process.pid) && !!ticket && ticketPattern.test(ticket);
	const surface: Surface = terminal ? "terminal" : "chat";
	if (!Number.isSafeInteger(generation) || generation < 1 ||
		(!terminal && process.env.CODEFLARE_PI_WEB_DAEMON !== "1")) return;

	const startTime = processStartTime();
	if (!startTime) return;
	const instance = randomUUID();
	const reportPath = join(stateDir, `${surface}.json`);
	const home = process.env.HOME ?? "";
	const agentDir = process.env.PI_CODING_AGENT_DIR || join(home, ".pi/agent");
	const sessionId = process.env.SESSION_ID ?? "";
	const mode = (terminal ? process.env.HERDR_ENV === "1" : process.env.CODEFLARE_TERMINAL_MODE === "herdr") ? "herdr" : "classic";
	const bindingDir = join(home, ".codeflare", mode, "sessions", `cf-${sessionId}`);
	let savedId: string | undefined;
	let ctx: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let unsubscribe: (() => void) | undefined;
	let editorIsIdle: (() => boolean) | undefined;
	let ready = false;
	let everPersisted = false;
	let uiPrompt = false;
	// Pi 1.5.2's editor returns before the native prompt promise. A missing
	// managed probe must never turn an in-flight request into idle evidence.
	const promptPending = () => {
		const probe = Reflect.get(globalThis, Symbol.for("codeflare.pi.nativePromptPending"));
		return typeof probe !== "function" || probe() !== false;
	};
	let stopRequested: string | undefined;
	let release: { requestId: string; draft?: string } | undefined;

	function accepts(owner: Owner | undefined | null): boolean {
		if (owner === undefined) return terminal && ticket === "initial" && process.env.CODEFLARE_PI_SURFACE === "terminal";
		if (!owner || (terminal && owner.terminalTicket !== ticket)) return false;
		if (owner.phase === "opening" || (terminal && owner.phase === "uncertain")) {
			return owner.target === surface && (owner.surface === null || owner.surface === surface);
		}
		return owner.surface === surface && ["active", "waiting", "stopping", "releasing", "complete", "cancelled", "failed"].includes(owner.phase);
	}

	function frozen(): boolean {
		const owner = readOwner(generation);
		return !!release || !accepts(owner) || owner?.phase === "waiting" || owner?.phase === "stopping" ||
			owner?.phase === "releasing" || owner?.phase === "opening" || owner?.phase === "uncertain";
	}

	function identity(context: ExtensionContext) {
		const manager = context.sessionManager;
		const header = manager.getHeader();
		const path = manager.getSessionFile();
		const id = manager.getSessionId();
		const cwd = manager.getCwd();
		const workspace = realpathSync(join(home, "workspace"));
		const root = join(agentDir, "sessions", `--${workspace.slice(1).replace(/[/:]/g, "-")}--`);
		if (!header || header.type !== "session" || !nativeIdPattern.test(id) || header.id !== id || header.cwd !== cwd ||
			cwd !== workspace || !path || !path.endsWith(`_${id}.jsonl`) || resolve(path) !== path || !path.startsWith(root + sep) ||
			dirname(path) !== root || realpathSync(root) !== root) return;
		return { id, cwd, path, header };
	}

	function inspect(context: ExtensionContext) {
		const binding = identity(context);
		if (!binding) return;
		let persisted = false;
		try {
			const stat = lstatSync(binding.path);
			everPersisted = true;
			if (!stat.isFile()) return;
			persisted = true;
		} catch (error) {
			if (!hasCode(error, "ENOENT") || everPersisted) return;
		}
		return { binding, persisted };
	}

	function persistBinding(binding: Binding) {
		if (!/^[a-z0-9]{8,24}$/.test(sessionId) || savedId === binding.id) return;
		// Verification reads the native header from disk, not just the filename.
		const fd = openSync(binding.path, "r");
		try { verifyDiskHeader(fd, fstatSync(fd).size, binding); } finally { closeSync(fd); }
		mkdirSync(bindingDir, { recursive: true, mode: 0o700 });
		atomicWrite(join(bindingDir, "agent-session-id"), binding.id + "\n");
		savedId = binding.id;
	}

	function sample(closing = false) {
		if (!ctx || !ready) return;
		const owner = readOwner(generation);
		if (!accepts(owner)) return;
		const evidence = inspect(ctx);
		if (!evidence) return;
		const { binding, persisted } = evidence;
		const bound = matchesBinding(owner?.binding, binding);
		if (!terminal && owner?.binding && !bound) return;
		const stopping = terminal && owner?.phase === "stopping" && owner.target === "chat" && bound ? owner.requestId : undefined;
		if (terminal && owner?.phase === "stopping" && !stopping) return;
		const promptIdle = !uiPrompt && (!terminal || !promptPending() && (closing || editorIsIdle?.() === true));
		if (!stopping || closing) stopRequested = undefined;
		else if ((!ctx.isIdle() || promptIdle) && (stopRequested !== stopping || ctx.hasPendingMessages())) {
			// TUI Abort restores native queued messages to the draft. Do not
			// acknowledge an idle-looking input hook that has not started a run yet.
			ctx.abort();
			stopRequested = stopping;
		}
		const releasing = owner?.phase === "releasing" && owner.target !== undefined && (!terminal || owner.target !== surface) && !!owner.requestId;
		let idle = ctx.isIdle() && !ctx.hasPendingMessages() && promptIdle;
		let leaf = ctx.sessionManager.getLeafId();
		if (!persisted) {
			// Pi defers the file until the first conversation message. A previously
			// seen or populated transcript must never become a new empty session.
			idle &&= !ctx.sessionManager.getEntries().some((entry) => entry.type === "message" || entry.type === "custom_message");
			if (idle) leaf = null;
		}
		const quitting = terminal && closing && !release && !releasing;
		if (releasing || quitting) {
			if (releasing) idle &&= bound;
			if (idle && persisted && diskLeaf(binding) !== leaf) {
				if (closing && !quitting) idle = false;
				else {
					pi.appendEntry("codeflare-handoff-branch", { leaf });
					leaf = ctx.sessionManager.getLeafId();
					idle = diskLeaf(binding) === leaf;
				}
			}
		}
		const released = closing && releasing && idle && (!terminal || release?.requestId === owner?.requestId);
		if (closing && !released && !(quitting && idle)) return;
		if (persisted && (terminal || bound) && !releasing && owner?.phase !== "waiting" && owner?.phase !== "stopping" && owner?.phase !== "opening") {
			persistBinding(binding);
		}
		atomicWrite(reportPath, JSON.stringify({
			generation, pid: process.pid, startTime, instance, ...binding, leaf, idle, persisted,
			...(terminal ? { ticket } : {}),
			...(stopping && stopRequested === stopping ? { stopRequested } : {}),
			...(releasing && idle ? { releaseReady: owner.requestId } : {}),
			...(released ? { released: true, ...(release?.draft ? { draft: release.draft } : {}) } : {}),
			...(quitting && idle ? { quit: true } : {}),
		}) + "\n");
		if (terminal && !closing && !release && releasing && idle && owner?.requestId) {
			const draft = ctx.ui.getEditorText();
			release = { requestId: owner.requestId, ...(draft ? { draft } : {}) };
			ctx.shutdown();
		}
	}

	function publish(closing = false) {
		// Withhold evidence on failed I/O or unexpected native state. Host must
		// require this process/instance and a fresh record; age never implies idle.
		try { sample(closing); } catch { /* no evidence */ }
	}

	function fenceEditor(context: ExtensionContext) {
		const ui = context.ui;
		const previous = ui.getEditorComponent();
		let editor: EditorComponent | undefined;
		let tui: TUI | undefined;
		let matches: ((data: string) => boolean) | undefined;
		let submissions = 0;
		const factory: NonNullable<ReturnType<typeof ui.getEditorComponent>> = (terminalUi, theme, keys) => {
			tui = terminalUi;
			matches = (data) => keys.matches(data, "tui.input.submit") || keys.matches(data, "app.message.followUp") || keys.matches(data, "app.message.dequeue");
			return editor = previous?.(terminalUi, theme, keys) ?? new CustomEditor(terminalUi, theme, keys, { embedWorkingStatus: true });
		};
		ui.setEditorComponent(factory);
		if (!editor?.onSubmit || !tui) return;
		const submit = editor.onSubmit.bind(editor);
		editor.onSubmit = async (text) => {
			if (frozen()) {
				ui.setEditorText(text);
				return;
			}
			submissions++;
			try { await submit(text); } finally { submissions--; }
		};
		// Only the actual prompt editor is fenced. A question/selector has its
		// own focus and receives native keys, including Enter and Escape.
		const promptFocused = () => (tui as TUI & { getFocusedComponent(): unknown }).getFocusedComponent() === editor;
		unsubscribe = ui.onTerminalInput((data) => {
			if (frozen() && promptFocused() && matches?.(data)) return { consume: true };
		});
		editorIsIdle = () => submissions === 0 && ui.getEditorComponent() === factory && promptFocused() && !tui?.hasOverlay();
	}

	function restoreDraft(context: ExtensionContext) {
		try {
			const previous = JSON.parse(readFileSync(reportPath, "utf8"));
			const binding = identity(context);
			if (binding && previous.generation === generation && previous.pid !== process.pid &&
				typeof previous.ticket === "string" && ticketPattern.test(previous.ticket) && previous.ticket !== ticket &&
				previous.released === true && matchesBinding(previous, binding) && typeof previous.draft === "string") {
				context.ui.setEditorText(previous.draft);
			}
		} catch { /* no matching draft */ }
	}

	pi.on("session_start", (event, context) => {
		if (context.mode !== (terminal ? "tui" : "rpc") || claims.has(context.sessionManager)) return;
		claims.add(context.sessionManager);
		ctx = context;
		const path = context.sessionManager.getSessionFile();
		const initialPath = terminal ? process.env.CODEFLARE_PI_TERMINAL_SESSION_PATH : readOwner(generation)?.binding?.path;
		everPersisted = event.reason === "resume" || (event.reason === "startup" && !!path && path === initialPath);
		try { inspect(context); } catch { /* withhold until the identity can be inspected */ }
		if (terminal && event.reason === "startup") restoreDraft(context);
	});
	pi.on("resources_discover", () => {
		if (!ctx || ready) return;
		if (terminal) fenceEditor(ctx);
		ready = true;
		publish();
		timer = setInterval(publish, 250);
		timer.unref();
	});
	// This evidence only pauses the Host's attachment timeout. It must never
	// substitute for the normal writer receipt published after resources load.
	function publishStartupQuestion(context: ExtensionContext, waiting: boolean) {
		if (terminal || ready || context.mode !== "rpc") return;
		try {
			const owner = readOwner(generation);
			if (owner?.phase !== "opening" || owner.target !== "chat" || !owner.requestId) return;
			const binding = identity(context);
			if (!binding || !matchesBinding(owner.binding, binding)) return;
			const { id, cwd, path } = binding;
			atomicWrite(join(stateDir, "chat-startup-question.json"), JSON.stringify({
				generation, pid: process.pid, startTime, requestId: owner.requestId, id, cwd, path, waiting,
			}));
		} catch { /* Withhold waiting evidence if the identity cannot be verified. */ }
	}
	pi.on("ui_prompt_start", (event, context) => {
		uiPrompt = true;
		if (event.kind === "confirm" || event.kind === "select" || event.kind === "input") publishStartupQuestion(context, true);
	});
	pi.on("ui_prompt_end", (_event, context) => {
		uiPrompt = false;
		publishStartupQuestion(context, false);
	});
	pi.on("before_agent_start", () => {
		if (terminal) {
			// Pi 1.5.2 latches Abort once a run starts preparing. A new
			// run has its own latch, even if the switch already stopped one.
			stopRequested = undefined;
			publish();
		}
	});
	pi.on("agent_start", () => {
		// A switch can land during another before_agent_start hook and
		// that hook can unblock before the next receipt poll.
		if (terminal) publish();
	});
	pi.on("session_before_switch", () => ctx && (!terminal || frozen()) ? { cancel: true } : undefined);
	pi.on("session_before_fork", () => ctx && (!terminal || frozen()) ? { cancel: true } : undefined);
	pi.on("session_before_tree", () => ctx && terminal && frozen() ? { cancel: true } : undefined);
	pi.on("session_shutdown", (event) => {
		if (!ctx) return;
		clearInterval(timer);
		unsubscribe?.();
		if (event.reason === "quit") publish(true);
		claims.delete(ctx.sessionManager);
		ctx = undefined;
	});
}
