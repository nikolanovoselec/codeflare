// Image PREPARE only: transform the integrity-locked upstream install, never
// the npm archive/lock or a running Pi session. No package code is executed.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const layouts = [
  {
    path: 'src/index.ts',
    pristine: '677355618c6306a39e5a9f8f7e3bc88329724731ff6549f5bcb9bfeca9bafaaf',
    prepared: '1fc3200ab602b7a0b3f5dc598df602fff44e0e1bc2edb17d5fc3fe091e9d2d77',
    replacements: [
      [`  // Gate nudge delivery on the parent's agent run. agent_settled fires exactly
  // once per run (from a finally block, so it also covers error and abort),
  // whereas agent_end fires once per run segment — retries, auto-compaction and
  // followUp continuations each emit one.`,
      `  // Flush withheld announcements after all tool results, before the next
  // model request. Keep agent_settled as the idle/error/abort fallback; turn_end
  // does not mean the parent's run is idle.`],
      ['  pi.on("agent_start", () => notifications.onParentAgentStart());',
        '  pi.on("agent_start", () => notifications.onParentAgentStart());\n  pi.on("turn_end", (event) => {\n    if (event.outcome === "completed") notifications.onParentTurnEnd();\n  });'],
    ],
  },
  {
    path: 'src/observation/notification.ts',
    pristine: '0ab98564669390039910c6761c4f21cbede133f56231c126302fab6c86babe47',
    prepared: 'ddea13a2d28394e25e11b37b4013ce89cba526c514d48cfea71c1e97f57342f1',
    replacements: [
      [`  // pi.sendMessage is fire-and-forget: while the parent's agent run is active,
  // a followUp is handed to a queue the extension cannot recall, yet it is only
  // delivered when the run drains that queue at turn end. A parent that pulls
  // the result in between would receive it twice. So nudges that arrive mid-run
  // are withheld here — where record.consumed is still consultable — and
  // flushed once the run settles.`,
      `  // pi.sendMessage is fire-and-forget. Withhold mid-run announcements until
  // turn_end so every tool result has landed and consumption is re-checked.
  // Steer then reaches the next model request without waiting for queued
  // followUps to drain. agent_settled remains the idle/error/abort fallback.`],
      ["  /** The parent's agent run became active; nudges are withheld until it settles. */",
        "  /** The parent's agent run became active; withhold until a safe boundary. */"],
      [`  /**
   * The parent's agent run settled. Flush the nudges withheld during it, each
   * re-checking consumption, so a result the parent pulled mid-run is dropped
   * rather than announced a second time.
   */
  onParentAgentSettled(): void {
    this.parentRunActive = false;
    const withheld = this.pending.splice(0);`,
      `  /** All tool results have landed; flush without declaring the run idle. */
  onParentTurnEnd(): void {
    this.flushPending("steer");
  }

  /** Idle fallback, including runs that errored or were aborted. */
  onParentAgentSettled(): void {
    this.parentRunActive = false;
    this.flushPending("followUp");
  }

  private flushPending(deliverAs: "steer" | "followUp"): void {
    if (this.disposed) return;
    const withheld = this.pending.splice(0);`],
      ['        if (entry.kind === "update") this.emitUpdate(entry.record, entry.message);\n        else this.emitIndividualNudge(entry.record);',
        '        if (entry.kind === "update") this.emitUpdate(entry.record, entry.message, deliverAs);\n        else this.emitIndividualNudge(entry.record, deliverAs);'],
      ['  private emitUpdate(record: Subagent, message: string): void {',
        '  private emitUpdate(record: Subagent, message: string, deliverAs: "steer" | "followUp" = "followUp"): void {'],
      [`      { deliverAs: "followUp", triggerTurn: true },
    );
  }

  private emitIndividualNudge(record: Subagent): void {`,
      `      { deliverAs, triggerTurn: true },
    );
  }

  private emitIndividualNudge(record: Subagent, deliverAs: "steer" | "followUp" = "followUp"): void {`],
      [`        customType: "subagent-notification",
        content: notification + pointerLines,
        display: true,`,
        `        customType: "subagent-notification",
        content: notification + pointerLines,
        // Keep routine success in model context without displaying its raw payload.
        display: record.status !== "completed" || Boolean(
          record.pendingQuestion || record.resumeRefusal || record.workspaceNotice || record.runUpdates.length
        ),`],
      [`      { deliverAs: "followUp", triggerTurn: true },
    );
  }

  /**
   * The trailing pointer lines:`,
      `      { deliverAs, triggerTurn: true },
    );
  }

  /**
   * The trailing pointer lines:`],
    ],
  },
];
const manifestDigest = '70c8a9e8a8358e6d12fdf4832f7e09a11e1a7e3e21f802307cfc3c83c2ee5969';
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

function readRegular(path) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`Unsafe subagents file: ${path}`);
  return readFileSync(path);
}

export function patchPiSubagentsNotifications(root) {
  for (const path of [root, join(root, 'src'), join(root, 'src/observation')]) {
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`Unsafe subagents directory: ${path}`);
  }
  const manifestBytes = readRegular(join(root, 'package.json'));
  const manifest = JSON.parse(manifestBytes.toString('utf8'));
  if (manifest.name !== '@gotgenes/pi-subagents' || manifest.version !== '25.0.5') {
    throw new Error('Unsupported subagents package identity/version; expected @gotgenes/pi-subagents 25.0.5');
  }
  if (digest(manifestBytes) !== manifestDigest) throw new Error('Subagents manifest digest changed');

  // Authentic npm file hashes, with only the exact prepared hashes allowed on
  // repeat. Calculate and validate BOTH changes before the first write.
  const files = layouts.map(layout => {
    const path = join(root, layout.path);
    const bytes = readRegular(path);
    const actual = digest(bytes);
    if (actual === layout.prepared) return { path, changed: false, source: bytes };
    if (actual !== layout.pristine) throw new Error(`Subagents source digest changed: ${layout.path}`);
    let source = bytes.toString('utf8');
    for (const [before, after] of layout.replacements) {
      if (source.split(before).length !== 2) throw new Error(`Subagents source layout changed: ${layout.path}`);
      source = source.replace(before, after);
    }
    if (digest(source) !== layout.prepared) throw new Error(`Subagents prepared digest changed: ${layout.path}`);
    return { path, changed: true, source };
  });
  for (const file of files) {
    if (file.changed) writeFileSync(file.path, file.source);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('usage: patch-pi-subagents-notifications.mjs SUBAGENTS_PACKAGE_ROOT');
    patchPiSubagentsNotifications(process.argv[2]);
  } catch (error) {
    console.error(`[patch-pi-subagents-notifications] FATAL: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
