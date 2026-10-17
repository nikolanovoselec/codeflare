import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
// Runtime layout: the managed agent's npm directory links to the image inventory.
// Package auto-discovery is filtered; this adapter initializes the native UI once.
import openTui from "../npm/node_modules/pi-open-tui/extensions/open-tui/index.ts";

function record(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function prepareConfig(ctx: ExtensionContext): boolean {
	const directory = getAgentDir();
	const path = join(directory, "open-tui.json");
	let temporary: string | undefined;
	try {
		mkdirSync(directory, { recursive: true });
		let config: Record<string, unknown> = {};
		let descriptor: number | undefined;
		try {
			descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
			if (!fstatSync(descriptor).isFile()) throw new Error("Unsafe configuration");
			const parsed: unknown = JSON.parse(readFileSync(descriptor, "utf8"));
			if (!record(parsed)) throw new Error("Invalid configuration");
			config = parsed;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		} finally {
			if (descriptor !== undefined) closeSync(descriptor);
		}
		for (const key of ["icons", "thinkingPeek", "footerSegments", "telemetry"]) {
			if (config[key] !== undefined && !record(config[key])) throw new Error("Invalid configuration");
		}
		const prepared = {
			...config,
			enabled: true,
			icons: { mode: "unicode", ...(config.icons as Record<string, unknown> | undefined) },
			thinkingPeek: { lines: 0, ...(config.thinkingPeek as Record<string, unknown> | undefined) },
			footerSegments: { ...(config.footerSegments as Record<string, unknown> | undefined), context: false, extensionStatuses: true },
		};
		temporary = `${path}.${randomUUID()}.tmp`;
		writeFileSync(temporary, `${JSON.stringify(prepared, null, 2)}\n`, { flag: "wx", mode: 0o600 });
		renameSync(temporary, path);
		return true;
	} catch {
		ctx.ui.notify("Open TUI configuration could not be safely prepared; using Pi's built-in UI.", "warning");
		return false;
	} finally {
		try { if (temporary) rmSync(temporary, { force: true }); } catch { /* Do not block the agent on cosmetic cleanup. */ }
	}
}

function boundProperty(target: object, key: PropertyKey): unknown {
	const value = Reflect.get(target, key, target);
	return typeof value === "function" ? value.bind(target) : value;
}

// Keep native rendering/lifecycle intact. Only the final public column budget is
// bounded: upstream's narrow header and a wide status grapheme can exceed it.
function terminalContext<T extends ExtensionContext>(ctx: T): T {
	const ui = new Proxy(ctx.ui, {
		get(target, key) {
			if (key !== "setHeader" && key !== "setFooter") return boundProperty(target, key);
			return (factory?: (...args: unknown[]) => Component) => Reflect.apply(target[key], target, [
				factory && ((...args: unknown[]) => {
					const component = factory(...args);
					return new Proxy(component, {
						get(target, key) {
							if (key !== "render") return boundProperty(target, key);
							return (width: number) => width <= 0 ? []
								: target.render(width).map(line => truncateToWidth(line, width, ""));
						},
					});
				}),
			]);
		},
	});
	return new Proxy(ctx, { get: (target, key) => key === "ui" ? ui : boundProperty(target, key) });
}

export default function (pi: ExtensionAPI): void {
	let prepared = false;
	openTui(new Proxy(pi, {
		get(target, key) {
			if (key === "on") return (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
				Reflect.apply(target.on, target, [event, async (data: unknown, ctx: ExtensionContext) => {
					if (ctx.mode !== "tui" || !ctx.hasUI) return;
					if (event === "session_start") prepared = prepareConfig(ctx);
					if (!prepared) return;
					try { return await handler(data, terminalContext(ctx)); }
					finally { if (event === "session_shutdown") prepared = false; }
				}]);
			if (key === "registerCommand") return (name: string, command: Parameters<ExtensionAPI["registerCommand"]>[1]) =>
				target.registerCommand(name, { ...command, async handler(args, ctx) {
					if (ctx.mode === "tui" && ctx.hasUI && prepared) await command.handler(args, terminalContext(ctx));
				} });
			return boundProperty(target, key);
		},
	}));
}
