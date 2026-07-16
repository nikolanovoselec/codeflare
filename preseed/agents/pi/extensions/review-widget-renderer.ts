// Display structure adapted from @gotgenes/pi-subagents/src/ui/widget-renderer.ts.
// The stock service API exposes fewer live fields than the package's internal Subagent,
// so this adapter projects only public service-record metrics.

import { truncateToWidth } from "./local-statusline";

export type ReviewWidgetTheme = {
  fg(color: string, text: string): string;
  bold(text: string): string;
};

export type ReviewWidgetAgent = {
  id: string;
  label: string;
  description: string;
  status: string;
  toolUses: number;
  startedAt: number;
  completedAt?: number;
  error?: string;
  lifetimeUsage: { input: number; output: number; cacheWrite: number };
  compactionCount: number;
};

type AgentCategories = {
  running: ReviewWidgetAgent[];
  queued: ReviewWidgetAgent[];
  finished: ReviewWidgetAgent[];
};

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const MAX_WIDGET_LINES = 12;

function formatDuration(milliseconds: number): string {
  const value = Math.max(0, milliseconds);
  if (value < 60_000) return `${(value / 1_000).toFixed(1)}s`;
  const seconds = Math.floor(value / 1_000);
  if (seconds < 3_600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  return `${Math.floor(seconds / 3_600)}h ${Math.floor((seconds % 3_600) / 60)}m`;
}

function formatTokens(agent: ReviewWidgetAgent): string {
  const total = agent.lifetimeUsage.input + agent.lifetimeUsage.output + agent.lifetimeUsage.cacheWrite;
  const count = total >= 1_000_000
    ? `${(total / 1_000_000).toFixed(1)}M`
    : total >= 1_000
      ? `${(total / 1_000).toFixed(1)}k`
      : String(total);
  const compactions = agent.compactionCount > 0 ? ` · ↻${agent.compactionCount}` : "";
  return `${count} token${compactions}`;
}

function categorizeAgents(agents: readonly ReviewWidgetAgent[]): AgentCategories {
  return {
    running: agents.filter((agent) => agent.status === "running"),
    queued: agents.filter((agent) => agent.status === "queued"),
    finished: agents.filter((agent) => agent.status !== "running" && agent.status !== "queued"),
  };
}

function renderRunningLine(
  agent: ReviewWidgetAgent,
  spinnerFrame: number,
  theme: ReviewWidgetTheme,
  now: number,
): string {
  const parts = [
    "running",
    `${agent.toolUses} tool use${agent.toolUses === 1 ? "" : "s"}`,
    formatTokens(agent),
    formatDuration(now - agent.startedAt),
  ];
  const frame = SPINNER[spinnerFrame % SPINNER.length];
  return `${theme.fg("accent", frame)} ${theme.bold(agent.label)} ${theme.fg("dim", "·")} ${theme.fg("dim", parts.join(" · "))}`;
}

function renderFinishedLine(agent: ReviewWidgetAgent, theme: ReviewWidgetTheme, now: number): string {
  const succeeded = agent.status === "completed" || agent.status === "steered";
  const icon = succeeded ? theme.fg("success", "✓") : theme.fg("error", "✗");
  const duration = formatDuration((agent.completedAt ?? now) - agent.startedAt);
  const error = agent.error ? ` · ${agent.error.slice(0, 60)}` : "";
  return `${icon} ${theme.fg("dim", agent.label)} ${theme.fg("dim", "·")} ${theme.fg("dim", `${agent.status} · ${agent.toolUses} tool use${agent.toolUses === 1 ? "" : "s"} · ${formatTokens(agent)} · ${duration}${error}`)}`;
}

function fixLastConnector(lines: string[]): string[] {
  if (lines.length > 1) lines[lines.length - 1] = lines[lines.length - 1].replace("├─", "└─");
  return lines;
}

export function renderReviewWidgetLines(input: {
  agents: readonly ReviewWidgetAgent[];
  spinnerFrame: number;
  terminalWidth: number;
  theme: ReviewWidgetTheme;
  now?: number;
}): string[] {
  const { agents, spinnerFrame, terminalWidth, theme } = input;
  const now = input.now ?? Date.now();
  const categories = categorizeAgents(agents);
  if (categories.running.length === 0 && categories.queued.length === 0 && categories.finished.length === 0) return [];

  const truncate = (line: string) => truncateToWidth(line, terminalWidth);
  const heading = truncate(theme.fg(categories.running.length || categories.queued.length ? "accent" : "dim", "● Review agents"));
  const running = categories.running.map((agent) => truncate(`${theme.fg("dim", "├─")} ${renderRunningLine(agent, spinnerFrame, theme, now)}`));
  const queued = categories.queued.length > 0
    ? [truncate(`${theme.fg("dim", "├─")} ${theme.fg("muted", "◦")} ${theme.fg("dim", `${categories.queued.length} queued`)}`)]
    : [];
  const finished = categories.finished.map((agent) => truncate(`${theme.fg("dim", "├─")} ${renderFinishedLine(agent, theme, now)}`));
  const body = [...running, ...queued, ...finished];

  if (body.length <= MAX_WIDGET_LINES - 1) return fixLastConnector([heading, ...body]);

  const visible = body.slice(0, MAX_WIDGET_LINES - 2);
  const hidden = body.length - visible.length;
  return fixLastConnector([
    heading,
    ...visible,
    truncate(`${theme.fg("dim", "├─")} ${theme.fg("dim", `+${hidden} more`)}`),
  ]);
}
