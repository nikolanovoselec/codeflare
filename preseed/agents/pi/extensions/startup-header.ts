import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

function padToWidth(text: string, width: number): string {
	const visible = visibleWidth(text);
	if (visible >= width) return truncateToWidth(text, width);
	return text + " ".repeat(width - visible);
}

function stat(label: string, value: string): string {
	return `${label.padEnd(8)} ${value}`;
}

function dashedLine(width: number): string {
	// Em-dash (U+2014) for the box's horizontal edges: renders one cell wide in
	// monospace terminal fonts and butts edge-to-edge, giving a continuous line
	// rather than the gappy look of ASCII hyphens. Deliberate exception to the
	// project-wide no-em-dash rule, which targets prose, not box-drawing.
	return "—".repeat(Math.max(0, width));
}

function shortCwd(cwd: string): string {
	return cwd.replace(/^\/home\/user/, "~");
}

function formatTokens(tokens: number | null): string {
	if (tokens === null) return "unknown";
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}m`;
	if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}k`;
	return String(tokens);
}

function installHeader(pi: ExtensionAPI, ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;

	ctx.ui.setHeader((_tui, theme) => ({
		render(width: number): string[] {
			const innerWidth = Math.max(44, width - 2);
			const horizontalPadding = 2;
			const logoWidth = 16;
			const gapWidth = 4;
			const rightWidth = Math.max(10, innerWidth - horizontalPadding * 2 - logoWidth - gapWidth);
			const model = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : "not selected";
			const effort = pi.getThinkingLevel?.() ?? "off";
			const usage = ctx.getContextUsage?.();
			const context = usage
				? `${formatTokens(usage.tokens)} / ${formatTokens(usage.contextWindow)}${usage.percent === null ? "" : ` (${Math.round(usage.percent)}%)`}`
				: "unknown";
			const tools = `${pi.getActiveTools().length}/${pi.getAllTools().length} active`;
			const session = ctx.sessionManager.getSessionFile()?.split("/").pop() ?? "ephemeral";

			const logo = [
				"████████████",
				"    ██    ██",
				"    ██    ██",
				"    ██    ██",
				"    ██    ██",
				"    ██    ██",
			];

			const stats = [
				stat("model", model),
				stat("effort", String(effort)),
				stat("context", context),
				stat("tools", tools),
				stat("cwd", shortCwd(ctx.cwd)),
				stat("session", session),
			];

			const border = `+${dashedLine(innerWidth)}+`;
			const blank = `|${" ".repeat(innerWidth)}|`;
			const rows = stats.map((line, index) => {
				const left = theme.bold(theme.fg("accent", padToWidth(logo[index] ?? "", logoWidth)));
				const right = theme.fg("muted", truncateToWidth(line, rightWidth));
				const content = `${" ".repeat(horizontalPadding)}${left}${" ".repeat(gapWidth)}${right}`;
				return `|${padToWidth(content, innerWidth)}|`;
			});

			return ["", border, blank, ...rows, blank, border, ""];
		},
		invalidate() {},
	}));
}

export default function (pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		installHeader(pi, ctx);
	});

	pi.on("model_select", async (_event, ctx) => {
		installHeader(pi, ctx);
	});

	pi.on("thinking_level_select", async (_event, ctx) => {
		installHeader(pi, ctx);
	});

	pi.registerCommand("builtin-header", {
		description: "Restore pi's built-in startup header",
		handler: async (_args, ctx) => {
			ctx.ui.setHeader(undefined);
			ctx.ui.notify("Built-in header restored", "info");
		},
	});
}
