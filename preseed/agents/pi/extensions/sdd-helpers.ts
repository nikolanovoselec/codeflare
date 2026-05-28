export type SddSubcommand = "init" | "edit" | "add" | "clean" | "mode";

export type SddRepoState = {
  dirty: boolean;
  hasSdd: boolean;
  hasOpenInitTriage: boolean;
};

export type SddCommandDecision =
  | { kind: "help"; message: string }
  | { kind: "error"; message: string }
  | { kind: "workflow"; subcommand: SddSubcommand; skill: string; normalizedCommand: string };

const SDD_SUBCOMMANDS = new Set(["init", "edit", "add", "clean", "mode"]);

export const SDD_HELP_TEXT = `sdd — spec-driven development

USAGE
  /sdd                              Show this help
  /sdd <subcommand> [arguments]     Run a subcommand

SUBCOMMANDS
  init [idea]            Bootstrap a new project or derive a spec from source.
  edit <domain>          Add or modify requirements in an existing domain.
  add <domain>           Create a new domain in an existing spec.
  clean                  Refactor a rotted spec. Flags: --scope=all|diff, --interactive|--auto|--unleashed
  mode <name>            Set autonomy mode: interactive | auto | unleashed

Hard gates: subcommands require a clean working tree. /sdd clean and /sdd mode require an existing sdd/ folder. /sdd init refuses once sdd/ exists unless open init triage remains.`;

export function sddSkillForSubcommand(subcommand: SddSubcommand): string {
  if (subcommand === "init") return "sdd-init";
  if (subcommand === "clean") return "sdd-clean";
  return "spec-driven-development";
}

export default function sddHelpersExtension(_pi?: unknown): void {
  // Helper module imported by codeflare-pi.ts. Pi loads every file in
  // extensions/ as an extension, so expose a no-op factory too.
}

export function sddCommandDecision(args: string, state: SddRepoState): SddCommandDecision {
  const trimmed = args.trim();
  if (!trimmed) return { kind: "help", message: SDD_HELP_TEXT };

  const [rawSubcommand] = trimmed.split(/\s+/, 1);
  const subcommand = rawSubcommand as SddSubcommand;
  if (!SDD_SUBCOMMANDS.has(rawSubcommand)) {
    return { kind: "help", message: `Unknown /sdd subcommand: ${rawSubcommand}\n\n${SDD_HELP_TEXT}` };
  }

  if (state.dirty) {
    return {
      kind: "error",
      message: "Refusing /sdd because the working tree has uncommitted changes. Commit, stash, or revert them first.",
    };
  }

  if ((subcommand === "clean" || subcommand === "mode") && !state.hasSdd) {
    return {
      kind: "error",
      message: `Refusing /sdd ${subcommand}: no sdd/ folder exists. Run /sdd init first.`,
    };
  }

  if (subcommand === "init" && state.hasSdd && !state.hasOpenInitTriage) {
    return {
      kind: "error",
      message: "/sdd init has already run for this project. Use /sdd edit <domain>, /sdd add <domain>, or /sdd clean.",
    };
  }

  return {
    kind: "workflow",
    subcommand,
    skill: sddSkillForSubcommand(subcommand),
    normalizedCommand: `/sdd ${trimmed}`,
  };
}
