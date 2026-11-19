import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  applyCodeflareImpeccableOverlay,
  replaceImpeccableTargets,
  updateImpeccableSkill,
  verifyReviewedImpeccableBundle,
} from '../../scripts/update-impeccable-skill.mjs';
import { managedImpeccableLauncher } from '../../scripts/impeccable-launcher.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const skillRoot = join(repoRoot, 'preseed/agents/claude/skills/impeccable');

function copyReviewedFixture(skillVersion, destination) {
  if (skillVersion === '4.8.2') {
    // Compatibility fixture, not a complete 4.8.2 artifact: policy references
    // are byte-identical to 4.8.0. Retain its browser command anchors and
    // launcher placeholders (replaced wholesale); reconstruct the actual
    // candidate SKILL.md bytes and engine requirement from the reviewed ZIP.
    copyReviewedFixture('4.8.0', destination);
    const skillPath = join(destination, 'SKILL.md');
    const skill = readFileSync(skillPath, 'utf8')
      .replace(/^description:.*$/m, 'description: "Use to design, redesign, critique, audit, polish or animate a frontend: websites, landing pages, dashboards, app UI, components, native iOS/Android screens, or a design system (DESIGN.md)."')
      .replace('version: 4.8.0\n', 'version: 4.8.2\n');
    assert.equal(createHash('sha256').update(skill).digest('hex'), '637b7b727122a273912454e6c7c2d7775186eb0c3c379c2a7c13bec595c61619');
    writeFileSync(skillPath, skill);
    writeFileSync(join(destination, 'scripts/VERSION'), '0.1.21\n');
    return;
  }
  if (!['4.8.0', '4.9.1', '4.10.0'].includes(skillVersion)) {
    cpSync(join(repoRoot, `host/__fixtures__/impeccable-${skillVersion}`), destination, { recursive: true });
    return;
  }
  const capture = readFileSync(join(repoRoot, `host/__fixtures__/impeccable-${skillVersion}-source.json`));
  // Immutable fixture contract: compact byte deltas retain the real release
  // inputs without duplicating its half-megabyte browser client on disk.
  assert.equal(createHash('sha256').update(capture).digest('hex'), skillVersion === '4.10.0'
    ? 'a9158e382ee512185c8c0091a714660226e21371bfca6e190a81d9fcdd534e14' : skillVersion === '4.9.1'
    ? 'b87682a2988dc4cf102ed9b1ac95a308f2e1a31babfdb27bbf4d91780592050a'
    : '920d9b5f81c0e7c5e1083c068910e9e80d291018ecd5a9776eb88c2da7d95ff5');
  const fixture = JSON.parse(capture);
  assert.equal(fixture.bundleSha256, skillVersion === '4.10.0'
    ? '76c056a775bef9f5ce1a80889b6f961e7d0f9a3e8ef6343789392130d0383148' : skillVersion === '4.9.1'
    ? 'f0e94487ffcf8e28d0d1cfb47f41918e3748c657f33f0f128ecf0a478ac85942'
    : '82e6f6ff3a2b18f46f0f2fc388c1ab7abf3ccc52bbfc522456396d13011d6706');
  for (const [name, file] of Object.entries(fixture.files)) {
    const base = join(repoRoot, 'host/__fixtures__', fixture.baseFixture, file.baseFile ?? name);
    let bytes = readFileSync(base);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.baseSha256, name);
    for (const change of [...file.changes].reverse()) {
      assert.ok(Number.isSafeInteger(change.start) && Number.isSafeInteger(change.end)
        && change.start >= 0 && change.end >= change.start && change.end <= bytes.length);
      bytes = Buffer.concat([bytes.subarray(0, change.start), Buffer.from(change.text), bytes.subarray(change.end)]);
    }
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, name);
    const target = join(destination, name);
    mkdirSync(dirname(target), { recursive: true });
    cpSync(base, target);
    writeFileSync(target, bytes);
  }
  if (skillVersion === '4.10.0') {
    for (const [name, text] of Object.entries(policyInputs410)) {
      const target = join(destination, 'reference', name);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text + '\n');
    }
  }
}


// Exact policy excerpts from the qualified 4.10.0 release extend the existing
// compact fixture, which omits these references. They exercise overlay inputs;
// full canonical references are checked independently below. No test depends
// on /tmp research files or on mutable canonical content for its input.
const policyInputs410 = {
  "init.md": "**Your first message opens with the sign-in when it's missing.** If `impeccable context` printed `ACCOUNT: not signed in` (or printed no `ACCOUNT:` line and `.claude/skills/impeccable/scripts/impeccable whoami` prints `Not signed in`), the first line of your first message to the person, before any question, structured or plain-chat, is: \"Run `npx impeccable login` to keep your critiques and audits in your Impeccable account. It's free, and creates the account if you're new.\" Say it once per init. Signed in, say nothing about it.",
  "doctor.md": "- **Tool version.** The installed skill is older than the published one. `impeccable context` reports that at boot as `UPDATE_AVAILABLE` and `npx impeccable update` fixes it, or the harness's plugin manager for a plugin install. Not this command's job.\n- **Schema drift.** An artifact was written by an older Impeccable: fields nothing reads, fields now expected, files in retired locations. Mechanical, and this command repairs most of it.\n- **Truth drift.** The code moved on and the document no longer describes it. No file comparison settles this. `document` owns DESIGN.md, `init` owns PRODUCT.md, and this command's job is to hand them a specific gap rather than a vague suspicion.\n\n```\n.claude/skills/impeccable/scripts/impeccable doctor --json\n```\n\n- **`auto`** carries no decision. Run `.claude/skills/impeccable/scripts/impeccable doctor --fix` once to apply these, then report what it moved in one line. Do not ask permission first, and do not ask about them afterward.\n- **`mention`** needs the user to know but not to decide anything now. State each one in a sentence with its offered fix.\n- **`route`** needs a specific command. Name the command and the gap it would close. Run it only if the user asks in this turn; `init` and `document` are conversations, not repairs you perform unattended.\n\nOn `design-md-sprawl`, run `.claude/skills/impeccable/scripts/impeccable design-compact` (with Step 1's `--target`) and show the person its proposal and saving. Add `--write` only once they agree here; the original moves to `.impeccable/design-full.md`. Never compact as a side effect.",
  "hooks.md": "4. If `<action>` is `on`, report what the command installed or repaired. If no installed skill folders were found or settings were skipped, surface that result and do not claim the hook will run. Otherwise note that the harness must load the updated settings (and satisfy any trust requirements) before it runs. On Hermes Agent, `on` cannot install or enable the plugin: if `impeccable context` reported `MANUAL_DETECTOR_REQUIRED`, tell the user to run `npx impeccable install` and then `hermes plugins enable impeccable-design-hook` instead.\n5. If `<action>` is `ignore-value`, `ignore-file`, or `ignore-rule`, just print the script output. The default scope is shared `.impeccable/config.json`; add `--local` only when the user explicitly asks for a private exception.\n6. If `<action>` is `status`, just print the script output. Do not add commentary unless the user asked a follow-up question.\n\n- When a user asks how far to trust the hook, say it runs the engine unsandboxed with the agent's environment and network access (in the Copilot cloud agent too, once `.github/hooks/impeccable.json` is committed), and that the launcher checks a downloaded engine against `.claude/skills/impeccable/scripts/engine-checksums.txt` before its first run; **never** call it sandboxed.\n- The hook never blocks an edit; it emits a post-edit reminder. (A Cursor project still on the old `preToolUse` gate can block a write until its manifest is migrated.) Disabling stops the reminders.\n- The hook is bundled with the Impeccable skill. Project installs use `.claude/settings.local.json`, `.codex/hooks.json`, `.cursor/hooks.json`, `.github/hooks/impeccable.json`, and `.gemini/settings.json`; a user-scope Claude install uses the active account's `$CLAUDE_CONFIG_DIR/settings.json` (default `~/.claude/settings.json`), and a user-scope Codex, Cursor or Grok install uses `~/.codex/hooks.json`, `~/.cursor/hooks.json` or `~/.grok/hooks/impeccable.json`. On Codex, the user must approve the hook via `/hooks` the first time. On Cursor, confirm hooks are enabled under Settings -> Hooks. On GitHub Copilot, the CLI loads `.github/hooks/impeccable.json` once it is committed to the repository's default branch, and the cloud agent reads it from the repo directly.\n\n   ```bash\n   .claude/skills/impeccable/scripts/impeccable hooks <action> [args...]\n   ```\n\n\n`hooks on`, `impeccable update`, or `impeccable doctor --fix` moves the entry to `postToolUse`.",
  "animate.md": "Spawn the shipped `impeccable-motion-reviewer` fresh (`impeccable_motion_reviewer` in Codex; `/impeccable-motion-reviewer` in Cursor; on GitHub Copilot say \"Use the impeccable-motion-reviewer agent\"), with no forked conversation history. Pass the original request, the motion thesis above, both capture directories (plus entrance and exit captures where applicable), DESIGN.md's motion rules if any, and the craft-floor reference path. The reviewer has no browser and reviews only the provided evidence. Never read its agent definition before spawning; the harness loads it. Wait with one long timeout; verify a disposition-first return with `continuity`, `craft`, `reduced_motion`, `material_fixes`, and `keep`. Respawn an empty or incomplete return once with the same packet. Only when the harness has no subagent capability, run a separate fresh pass from [degraded/motion-reviewer.md](degraded/motion-reviewer.md), and disclose the substitution at finish.\n\n```sh\n.claude/skills/impeccable/scripts/impeccable motion-capture <url> --click '<selector>' --region '<region-selector>' --out-dir .impeccable/review/motion/normal\n.claude/skills/impeccable/scripts/impeccable motion-capture <url> --click '<selector>' --region '<region-selector>' --reduced-motion --out-dir .impeccable/review/motion/reduced\n```\n",
  "new-work.md": "Then spawn the shipped finish reviewer, `impeccable-finish-reviewer` (`impeccable_finish_reviewer` in codex; `/impeccable-finish-reviewer` in Cursor; on GitHub Copilot say \"Use the impeccable-finish-reviewer agent\"), with the original request, confirmed answers, the artifact path, the screenshot paths, the direction contract, existing hook findings, the QUALITY BAR card and approved comp paths (a code-led build has no approved comp; the chosen decision comp rides in that slot as the critique reference, named as such), on a comp-led build the build state (`.impeccable/build/state.json`), the spec, and the diff directories (`.impeccable/review/diff/hero/` and `.impeccable/review/diff/final/`, whose side-by-side, heatmap, region pairs, and `report.json` are the fidelity evidence), the craft-floor reference path, one line saying whether the build was code-led and whether image generation existed, and on a native platform the platform reference path(s), [ios.md](ios.md) / [android.md](android.md), both on adaptive, plus one line saying no detector ran, so the reviewer judges in the platform's conventions rather than the web's. The reviewer has no browser; screenshots you fail to pass are checks it cannot run. Never read the shipped agents' definition files before spawning; the harness loads them at spawn, and you owe only the input packet. Wait on any agent with one long timeout rather than a loop of short polls, and spend the wait on the next independent step. Verify the return carries the five contract sections (a recapture return carries one, its recapture list); on an empty or thrashed return, respawn once with the same inputs. This review never runs inside the build thread and never inherits it: spawn the reviewer fresh, with no forked conversation history (`fork_turns: 0` in codex); a reviewer that inherits your transcript inherits your framing, your optimism, and your abstractions, and everything it needs travels in the inputs above. Only a harness with no subagent capability at all substitutes a fresh in-thread pass after stepping fully out of the build context, run from [degraded/finish-reviewer.md](degraded/finish-reviewer.md), and a substituted or failed-and-replaced review is disclosed in one line at finish, never silently.\n\nAfter the last correction, on a new or replacement world or an approved system change where a DESIGN.md already exists at the write boundary, collect the choice [document.md](document.md) requires: show the user the existing file. Ask with the AskUserQuestion tool and wait for the answer before continuing. Offer refresh, overwrite, or merge. A seeded world's first build asks nothing: a seed exists to be replaced by the system the build resolved, so the choice is refresh, keeping the frontmatter's `world:` line and the `seededFrom` key in the sidecar. Then spawn the shipped documenter, `impeccable-documenter` (`impeccable_documenter` in codex); spawn it in the same message as the verdict or full-review request that follows the correction round rather than waiting for that return (if the request already went out alone, spawn it at once), and spawn it again after any later correction batch, once the earlier documenter has returned so its write never lands last, with the project root, artifact path, direction contract, PRODUCT.md, [document.md](document.md), write boundary, and that choice; the documenter cannot ask and writes nothing over an existing DESIGN.md without it. Without subagents, load [degraded/documenter.md](degraded/documenter.md) and [document.md](document.md) before writing. Verify the outcome: new worlds, a seeded world's first build, and approved system changes require token-bearing DESIGN.md **and** `.impeccable/design.json`, not prose alone. Ordinary extensions compare the finished build against the incumbent system, preserve its files, and report the evidence checked; report pre-existing drift without repairing it unasked. Recheck after later edits. Finish only when review and documentation are complete.\n\nRead [new-work-world.md](new-work-world.md) now and follow it: this path's steps, the roll and the decision page live there. Come back for step 4 once a direction is locked.\n\nOn a comp-led build, read [new-work-comp.md](new-work-comp.md) before writing the spec or any code, and follow it: the measured contract, the spec, and the build-phase gates live there.\n\nOn a new or replacement world, DESIGN.md is written at finish, from the built world, by the shipped documenter (section 7); a rulebook written before the build gets defended against reality instead of describing it, and hands the design-system detector an unstable target.\n\nAct on the disposition word; there are exactly four.\n\nwithout one, run the scoring fresh from [degraded/finish-reviewer.md](degraded/finish-reviewer.md)'s Verdict Pass",
  "new-work-world.md": "With parallel subagents, fan out one agent per card: each spawn is the shipped asset producer with a single-comp packet, that card's fields, its world's card images when the NEXT line names them, PRODUCT.md, the shared frame, the path to visualize.md for its comp discipline, the COMPS section of the MODE RULES block copied verbatim (the subagent never sees the roll's output), and the card's declared path, up to four in flight.\n\nWithout parallel subagents, generate in the main thread after serving, same order,",
  "new-work-comp.md": "With parallel subagents, spawn the shipped asset producer (`impeccable-asset-producer`; `impeccable_asset_producer` in codex; `/impeccable-asset-producer` in Cursor; on GitHub Copilot say \"Use the impeccable-asset-producer agent\") with the spec path and let it produce them all; without subagents, produce them here.",
  "degraded/motion-reviewer.md": "<!-- Generated from skill/agents/ at build time. Do not edit; edit the agent definition. -->\nThis harness has no subagent capability, so you are running this role inline. Step fully out of the work you just finished, adopt only this file's instructions for the pass, and disclose the substitution in one line of your closing message to the user, outside the output contract. Where the text below addresses a parent agent, you are both parties: produce the full output contract first, then act on it yourself.",
  "degraded/finish-reviewer.md": "<!-- Generated from skill/agents/ at build time. Do not edit; edit the agent definition. -->\nThis harness has no subagent capability, so you are running this role inline. Step fully out of the work you just finished, adopt only this file's instructions for the pass, and disclose the substitution in one line of your closing message to the user, outside the output contract. Where the text below addresses a parent agent, you are both parties: produce the full output contract first, then act on it yourself.",
  "degraded/documenter.md": "<!-- Generated from skill/agents/ at build time. Do not edit; edit the agent definition. -->\nThis harness has no subagent capability, so you are running this role inline. Step fully out of the work you just finished, adopt only this file's instructions for the pass, and disclose the substitution in one line of your closing message to the user, outside the output contract. Where the text below addresses a parent agent, you are both parties: produce the full output contract first, then act on it yourself.",
  "degraded/asset-producer.md": "<!-- Generated from skill/agents/ at build time. Do not edit; edit the agent definition. -->\nThis harness has no subagent capability, so you are running this role inline. Step fully out of the work you just finished, adopt only this file's instructions for the pass, and disclose the substitution in one line of your closing message to the user, outside the output contract. Where the text below addresses a parent agent, you are both parties: produce the full output contract first, then act on it yourself."
};

function withTempDir(run) {
  const root = mkdtempSync(join(tmpdir(), 'codeflare-impeccable-'));
  try {
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// These assertions name the managed dependency/role contracts delivered to the
// agent, not the aesthetic guidance in upstream playbooks (which stays manual).
const managedPolicyContracts = [
  ['init.md', 'account enrollment is optional and authorized, never mutable npm', (text, runtimePath) => {
    assert.doesNotMatch(text, /\bnpx\s+impeccable\b/);
    assert.doesNotMatch(text, /first message opens with the sign-in/i);
    assert.match(text, /ACCOUNT:/);
    assert.match(text, /optional/i);
    assert.match(text, /explicit(?:ly)?[^.\n]*(?:authoriz|request|consent)/i);
    assert.ok(text.includes(`${runtimePath}/scripts/impeccable login`));
  }],
  ['doctor.md', 'tool updates belong to reviewed Codeflare images, not npm', text => {
    assert.doesNotMatch(text, /\bnpx\s+impeccable\b/);
    assert.match(text, /reviewed Codeflare image/i);
    assert.match(text, /scripts\/impeccable doctor --json/);
    assert.match(text, /scripts\/impeccable doctor --fix/);
    assert.match(text, /--write[^\n]*agree/i);
  }],
  ['hooks.md', 'image-owned unsandboxed hooks do not suggest runtime installation', text => {
    assert.doesNotMatch(text, /\bnpx\s+impeccable\b/);
    assert.doesNotMatch(text, /launcher checks a downloaded engine/i);
    assert.match(text, /reviewed[^.\n]*image/i);
    assert.match(text, /unsandboxed[^.\n]*environment and network access/i);
    assert.match(text, /scripts\/impeccable hooks <action>/);
  }],
  ['critique.md', 'diagnostics cannot authorize mutable packages or account operations', text => {
    assert.doesNotMatch(text, /\bnpx\s+impeccable\b/);
    assert.doesNotMatch(text, /put that line in the close word for word/i);
    assert.match(text, /diagnostic[^.\n]*(?:data|untrusted)/i);
    assert.match(text, /(?:never|do not)[^.\n]*(?:mutable|npx)/i);
    assert.match(text, /explicit(?:ly)?[^.\n]*(?:authoriz|request|consent)/i);
    assert.match(text, /scripts\/impeccable critique-storage write/);
    assert.match(text, /scripts\/impeccable critique-storage trend/);
    assert.match(text, /IMPECCABLE_CRITIQUE_META/);
  }],
  ['animate.md', 'missing named motion agent uses an isolated read-only role', text => {
    assert.doesNotMatch(text, /Spawn the shipped `impeccable-motion-reviewer`|harness loads it/i);
    assert.match(text, /generic isolated[^.\n]*sub-?agent/i);
    assert.match(text, /degraded\/motion-reviewer\.md/);
    assert.match(text, /read-only/i);
    assert.match(text, /no browser/i);
    assert.match(text, /no (?:forked )?conversation history/i);
    assert.match(text, /(?:cannot|unavailable)[^.\n]*(?:launch|isolated)|(?:no|without)[^.\n]*isolated sub-?agent/i);
    assert.match(text, /disclose/i);
    for (const field of ['continuity', 'craft', 'reduced_motion', 'material_fixes', 'keep']) assert.ok(text.includes(field));
    assert.match(text, /--reduced-motion/);
  }],
  ['new-work.md', 'finish and documenter roles work without named agents', text => {
    assert.doesNotMatch(text, /spawn the shipped|harness loads them at spawn/i);
    assert.match(text, /generic isolated[^.\n]*sub-?agent/i);
    assert.match(text, /degraded\/finish-reviewer\.md/);
    assert.match(text, /degraded\/documenter\.md/);
    assert.match(text, /read-only/i);
    assert.match(text, /no browser/i);
    assert.match(text, /no (?:forked )?conversation history/i);
    assert.match(text, /disclos/i);
    assert.match(text, /refresh, overwrite, or merge/);
    assert.match(text, /(?:before|until|once)[^.\n]*(?:earlier|previous)[^.\n]*documenter[^.\n]*(?:returned|finished|complete)/i);
    assert.match(text, /new-work-world\.md/);
    assert.match(text, /new-work-comp\.md/);
  }],
  ['new-work-world.md', 'decision-comp producer uses its delivered isolated role', text => {
    assert.doesNotMatch(text, /spawn is the shipped asset producer/i);
    assert.match(text, /generic isolated[^.\n]*sub-?agent/i);
    assert.match(text, /degraded\/asset-producer\.md/);
    assert.match(text, /single-comp packet/);
  }],
  ['new-work-comp.md', 'plate producer uses its delivered isolated role', text => {
    assert.doesNotMatch(text, /spawn the shipped asset producer/i);
    assert.match(text, /generic isolated[^.\n]*sub-?agent/i);
    assert.match(text, /degraded\/asset-producer\.md/);
    assert.match(text, /without subagents, produce them here/);
  }],
];

function projectReviewed410(root) {
  const source = join(root, 'source');
  copyReviewedFixture('4.10.0', source);
  applyCodeflareImpeccableOverlay(source);
  const targets = ['claude', 'pi'].map(agent => ({
    agent, root: join(root, agent),
    runtimePath: agent === 'claude' ? '~/.claude/skills/impeccable' : '~/.pi/agent/skills/impeccable',
  }));
  replaceImpeccableTargets(source, readFileSync(join(source, 'SKILL.md'), 'utf8'), targets);
  return { source, targets };
}

function runtimeProbe(root) {
  const { targets } = projectReviewed410(root);
  const engines = join(root, 'engines');
  const engine = join(engines, '0.1.27/impeccable');
  mkdirSync(dirname(engine), { recursive: true });
  // A transport probe only: no simulated uploads/downloads or imitation Rust
  // flag semantics. Actual native side effects require installed-image tests.
  writeFileSync(engine, `#!${process.execPath}
const { readFileSync } = require('node:fs');
process.stdout.write(JSON.stringify({
  argv: process.argv.slice(2), cwd: process.cwd(), stdin: readFileSync(0, 'utf8'),
  switchSync: process.env.IMPECCABLE_NO_SWITCH_SYNC,
  telemetry: process.env.IMPECCABLE_NO_TELEMETRY, pro: process.env.IMPECCABLE_PRO,
  skill: process.env.IMPECCABLE_SKILL_DIR, self: process.env.IMPECCABLE_SELF,
  metadata: process.env.IMPECCABLE_CRITIQUE_META, ci: process.env.CI,
}));
process.stderr.write('native diagnostic\\n');
process.exitCode = Number(process.env.PROBE_EXIT || 0);
`, { mode: 0o755 });
  for (const target of targets) {
    const launcher = join(target.root, 'scripts/impeccable');
    writeFileSync(launcher, managedImpeccableLauncher(engines), { mode: 0o755 });
    chmodSync(launcher, 0o755);
  }
  return targets;
}

describe('Impeccable managed runtime policy', () => {
  for (const inherited of [undefined, '', 'false']) {
    it(`REQ-AGENT-181: child receives enforced managed opt-outs with inherited ${JSON.stringify(inherited)}`, () => withTempDir(root => {
      const targets = runtimeProbe(root);
      const env = { ...process.env, CI: '' };
      for (const key of ['IMPECCABLE_NO_SWITCH_SYNC', 'IMPECCABLE_NO_TELEMETRY', 'IMPECCABLE_PRO']) {
        if (inherited === undefined) delete env[key];
        else env[key] = key === 'IMPECCABLE_PRO' && inherited ? 'on' : inherited;
      }
      for (const target of targets) {
        const result = spawnSync(join(target.root, 'scripts/impeccable'), ['context'], {
          encoding: 'utf8', input: '', cwd: root, env,
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        const child = JSON.parse(result.stdout);
        assert.equal(child.ci, '', 'CI must not mask missing managed policy');
        assert.deepEqual({ switchSync: child.switchSync, telemetry: child.telemetry, pro: child.pro },
          { switchSync: '1', telemetry: '1', pro: 'off' });
      }
    }));
  }

  it('REQ-AGENT-181: managed dispatch preserves local command inputs, output and failure status', () => withTempDir(root => {
    const targets = runtimeProbe(root);
    const metadata = JSON.stringify({ target: 'a file.ts', total_score: 8, max_score: 12 });
    for (const target of targets) {
      const launcher = join(target.root, 'scripts/impeccable');
      for (const argv of [
        ['context', '--target', 'a file.ts'], ['detect', '--json', 'a file.ts'],
        ['hook', 'a file.ts'], ['doctor', '--json'],
        ['critique-storage', 'write', 'a file.ts', 'report body.md'],
        ['audit-storage', 'write', 'a file.ts', 'report body.md'],
        ['critique-storage', 'trend', 'a file.ts', '5'],
      ]) {
        const result = spawnSync(launcher, argv, {
          encoding: 'utf8', cwd: root, input: 'Local report body.\n',
          env: { ...process.env, CI: '', IMPECCABLE_CRITIQUE_META: metadata, PROBE_EXIT: '23' },
        });
        assert.ifError(result.error);
        assert.equal(result.status, 23);
        assert.equal(result.stderr, 'native diagnostic\n');
        const child = JSON.parse(result.stdout);
        assert.deepEqual({ argv: child.argv, cwd: child.cwd, stdin: child.stdin, metadata: child.metadata,
          skill: child.skill, self: child.self },
        { argv, cwd: root, stdin: 'Local report body.\n', metadata, skill: target.root, self: launcher });
      }
    }
  }));

  for (const [file, contract, check] of managedPolicyContracts) {
    for (const agent of ['claude', 'pi']) {
      it(`REQ-AGENT-181: ${agent} 4.10.0 projected policy: ${contract}`, () => withTempDir(root => {
        const { targets } = projectReviewed410(root);
        const target = targets.find(item => item.agent === agent);
        const delivered = readFileSync(join(target.root, 'reference', file), 'utf8');
        check(delivered, target.runtimePath);
        // Reapply to the already-projected tree, exactly as a managed refresh
        // does; byte-equal delivery is the idempotent projection contract.
        applyCodeflareImpeccableOverlay(target.root, { allowAlreadyApplied: true });
        assert.equal(readFileSync(join(target.root, 'reference', file), 'utf8'), delivered);
      }));
      it(`REQ-AGENT-181: ${agent} 4.10.0 canonical policy: ${contract}`, () => {
        const runtimePath = agent === 'claude' ? '~/.claude/skills/impeccable' : '~/.pi/agent/skills/impeccable';
        const canonical = join(repoRoot, 'preseed/agents', agent, 'skills/impeccable/reference', file);
        check(readFileSync(canonical, 'utf8'), runtimePath);
      });
    }
    it(`REQ-AGENT-181: missing ${file} managed-policy input fails before any overlay write`, () => withTempDir(source => {
      copyReviewedFixture('4.10.0', source);
      writeFileSync(join(source, 'reference', file), 'Incomplete upstream policy input.\n');
      const outputs = ['SKILL.md', 'scripts/impeccable', 'scripts/live-browser.js',
        ...managedPolicyContracts.map(([name]) => `reference/${name}`)];
      const before = outputs.map(name => readFileSync(join(source, name)));
      assert.throws(() => applyCodeflareImpeccableOverlay(source), /overlay anchor|ENOENT/);
      assert.deepEqual(outputs.map(name => readFileSync(join(source, name))), before);
    }));
  }

  it('REQ-AGENT-181: native bundle refresh preserves policy without a retired JavaScript server', () => withTempDir((root) => {
    const source = join(root, 'source');
    cpSync(join(repoRoot, 'host/__fixtures__/impeccable-4.3.1'), source, { recursive: true });
    applyCodeflareImpeccableOverlay(source);
    const target = join(root, 'target');
    replaceImpeccableTargets(source, readFileSync(join(source, 'SKILL.md'), 'utf8'), [{
      agent: 'pi', root: target, runtimePath: '~/.pi/agent/skills/impeccable',
    }]);
    const skill = readFileSync(join(target, 'SKILL.md'), 'utf8');
    assert.doesNotMatch(skill, /Bash\(npx impeccable/);
    applyCodeflareImpeccableOverlay(target, { allowAlreadyApplied: true });
    const launcher = join(target, 'scripts/impeccable');
    const result = spawnSync('sh', [launcher, 'update'], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /image-owned/);
  }));

  it('REQ-AGENT-181: current native bundle refresh dispatches through its reviewed image engine without a retired JavaScript server', () => withTempDir((root) => {
    const source = join(root, 'source');
    cpSync(join(repoRoot, 'host/__fixtures__/impeccable-4.3.1'), source, { recursive: true });
    const skillPath = join(source, 'SKILL.md');
    assert.equal(existsSync(join(source, 'scripts/serve-question.mjs')), false);
    applyCodeflareImpeccableOverlay(source);

    const target = join(root, 'target');
    replaceImpeccableTargets(source, readFileSync(skillPath, 'utf8'), [{
      agent: 'pi', root: target, runtimePath: '~/.pi/agent/skills/impeccable',
    }]);
    assert.equal(existsSync(join(target, 'scripts/serve-question.mjs')), false);

    const engineRoot = join(root, 'engine');
    const engine = join(engineRoot, '0.1.5', 'impeccable');
    mkdirSync(dirname(engine), { recursive: true });
    writeFileSync(engine, '#!/bin/sh\nprintf "%s\\n" "$@"\n', { mode: 0o755 });
    const launcher = join(target, 'scripts/impeccable');
    writeFileSync(launcher, managedImpeccableLauncher(engineRoot), { mode: 0o755 });
    const result = spawnSync(launcher, ['context', '--target', 'file.ts'], { encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.deepEqual(result.stdout.trim().split('\n'), ['context', '--target', 'file.ts']);
  }));

  for (const [skillVersion, engineVersion] of [['4.3.1', '0.1.5'], ['4.4.0', '0.1.10'], ['4.5.0', '0.1.11'], ['4.6.0', '0.1.15'], ['4.7.0', '0.1.16'], ['4.8.0', '0.1.18'], ['4.8.2', '0.1.21'], ['4.9.1', '0.1.24'], ['4.10.0', '0.1.27']]) {
    it(`REQ-AGENT-181: reviewed ${skillVersion} dispatches only to its matching image engine ${engineVersion}`, () => withTempDir(root => {
      const source = join(root, 'source');
      copyReviewedFixture(skillVersion, source);
      applyCodeflareImpeccableOverlay(source);
      applyCodeflareImpeccableOverlay(source, { allowAlreadyApplied: true });
      const targets = ['claude', 'pi'].map(agent => ({ agent, root: join(root, agent),
        runtimePath: agent === 'claude' ? '~/.claude/skills/impeccable' : '~/.pi/agent/skills/impeccable' }));
      replaceImpeccableTargets(source, readFileSync(join(source, 'SKILL.md'), 'utf8'), targets);
      const engines = join(root, 'engines');
      for (const otherVersion of ['0.1.5', '0.1.10', '0.1.11', '0.1.15', '0.1.16', '0.1.18', '0.1.21', '0.1.24', '0.1.27'].filter(version => version !== engineVersion)) {
        const other = join(engines, otherVersion, 'impeccable');
        mkdirSync(dirname(other), { recursive: true });
        writeFileSync(other, '#!/bin/sh\necho incorrect-fallback\n', { mode: 0o755 });
      }
      const pinName = skillVersion === '4.9.1' ? 'impeccable-engine.json'
        : skillVersion === '4.3.1' ? 'impeccable-engine-legacy.json' : `impeccable-engine-${skillVersion}.json`;
      const pin = JSON.parse(readFileSync(join(repoRoot, 'image', pinName), 'utf8'));
      // Model the engine provided by the real image pin, not just the expected
      // launcher mapping. A changed/missing compatibility pin must fail dispatch.
      const engine = join(engines, pin.version, 'impeccable');
      mkdirSync(dirname(engine), { recursive: true });
      writeFileSync(engine, `#!/bin/sh\nprintf '%s\\n' '${engineVersion}' "$IMPECCABLE_SKILL_DIR" "$IMPECCABLE_SELF" "$@"\n`, { mode: 0o755 });
      for (const target of targets) {
        const launcher = join(target.root, 'scripts/impeccable');
        writeFileSync(launcher, managedImpeccableLauncher(engines), { mode: 0o755 });
        chmodSync(launcher, 0o755);
        const result = spawnSync(launcher, ['context', '--target', 'a file.ts'], {
          encoding: 'utf8', env: { ...process.env, IMPECCABLE_BIN: '/does/not/exist' },
        });
        assert.ifError(result.error);
        assert.equal(result.status, 0, result.stderr);
        assert.deepEqual(result.stdout.trim().split('\n'), [engineVersion, target.root, launcher, 'context', '--target', 'a file.ts']);
        for (const command of ['install', 'update', 'uninstall', 'link']) {
          for (const args of [[command], ['skills', command]]) {
            const denied = spawnSync(launcher, args, { encoding: 'utf8' });
            assert.equal(denied.status, 1);
            assert.equal(denied.stdout, '');
            assert.match(denied.stderr, /image-owned/);
          }
        }
      }
      rmSync(engine);
      for (const target of targets) {
        const missing = spawnSync(join(target.root, 'scripts/impeccable'), ['context'], { encoding: 'utf8' });
        assert.equal(missing.status, 127);
        assert.equal(missing.stdout, '');
        assert.match(missing.stderr, /missing from this Codeflare image/);
      }
    }));
  }

  it('REQ-AGENT-181: unreviewed native engine fails before source mutation', () => withTempDir((source) => {
    cpSync(join(repoRoot, 'host/__fixtures__/impeccable-4.3.1'), source, { recursive: true });
    const before = readFileSync(join(source, 'SKILL.md'), 'utf8');
    writeFileSync(join(source, 'scripts/VERSION'), '0.1.4\n');
    assert.throws(() => applyCodeflareImpeccableOverlay(source), /engine version/);
    assert.equal(readFileSync(join(source, 'SKILL.md'), 'utf8'), before);
  }));

  it('REQ-AGENT-181: 4.5.0 rejects an older engine before source mutation', () => withTempDir(source => {
    cpSync(join(repoRoot, 'host/__fixtures__/impeccable-4.5.0'), source, { recursive: true });
    const before = readFileSync(join(source, 'SKILL.md'), 'utf8');
    writeFileSync(join(source, 'scripts/VERSION'), '0.1.10\n');
    assert.throws(() => applyCodeflareImpeccableOverlay(source), /expected image-owned 0\.1\.11/);
    assert.equal(readFileSync(join(source, 'SKILL.md'), 'utf8'), before);
  }));

  it('REQ-AGENT-181: 4.6.0 rejects an older engine before source mutation', () => withTempDir(source => {
    cpSync(join(repoRoot, 'host/__fixtures__/impeccable-4.6.0'), source, { recursive: true });
    const before = readFileSync(join(source, 'SKILL.md'), 'utf8');
    writeFileSync(join(source, 'scripts/VERSION'), '0.1.11\n');
    assert.throws(() => applyCodeflareImpeccableOverlay(source), /expected image-owned 0\.1\.15/);
    assert.equal(readFileSync(join(source, 'SKILL.md'), 'utf8'), before);
  }));

  it('REQ-AGENT-181: 4.7.0 rejects an older engine before source mutation', () => withTempDir(source => {
    cpSync(join(repoRoot, 'host/__fixtures__/impeccable-4.7.0'), source, { recursive: true });
    const before = readFileSync(join(source, 'SKILL.md'), 'utf8');
    writeFileSync(join(source, 'scripts/VERSION'), '0.1.15\n');
    assert.throws(() => applyCodeflareImpeccableOverlay(source), /expected image-owned 0\.1\.16/);
    assert.equal(readFileSync(join(source, 'SKILL.md'), 'utf8'), before);
  }));

  it('REQ-AGENT-181: 4.8.0 rejects retained older engines before any overlay mutation', () => withTempDir(source => {
    copyReviewedFixture('4.8.0', source);
    const skillPath = join(source, 'SKILL.md');
    const before = readFileSync(skillPath, 'utf8');
    writeFileSync(join(source, 'scripts/VERSION'), '0.1.16\n');
    assert.throws(() => applyCodeflareImpeccableOverlay(source), /expected image-owned 0\.1\.18/);
    assert.equal(readFileSync(skillPath, 'utf8'), before);
  }));

  it('REQ-AGENT-181: 4.8.2 rejects the current image engine before any overlay mutation', () => withTempDir(source => {
    copyReviewedFixture('4.8.2', source);
    const skillPath = join(source, 'SKILL.md');
    const before = readFileSync(skillPath, 'utf8');
    writeFileSync(join(source, 'scripts/VERSION'), '0.1.18\n');
    assert.throws(() => applyCodeflareImpeccableOverlay(source), /expected image-owned 0\.1\.21/);
    assert.equal(readFileSync(skillPath, 'utf8'), before);
  }));

  it('REQ-AGENT-181: 4.9.1 rejects the retained 4.8.2 engine before any overlay mutation', () => withTempDir(source => {
    copyReviewedFixture('4.9.1', source);
    const skillPath = join(source, 'SKILL.md');
    const before = readFileSync(skillPath, 'utf8');
    writeFileSync(join(source, 'scripts/VERSION'), '0.1.21\n');
    assert.throws(() => applyCodeflareImpeccableOverlay(source), /expected image-owned 0\.1\.24/);
    assert.equal(readFileSync(skillPath, 'utf8'), before);
  }));

  it('REQ-AGENT-181: 4.10.0 rejects an older engine or a missing relocated rubric before overlay mutation', () => withTempDir(source => {
    copyReviewedFixture('4.10.0', source);
    const skillPath = join(source, 'SKILL.md');
    const browserPath = join(source, 'scripts/live-browser.js');
    const before = [readFileSync(skillPath), readFileSync(browserPath)];
    writeFileSync(join(source, 'scripts/VERSION'), '0.1.24\n');
    assert.throws(() => applyCodeflareImpeccableOverlay(source), /expected image-owned 0\.1\.27/);
    assert.deepEqual([readFileSync(skillPath), readFileSync(browserPath)], before);
    writeFileSync(join(source, 'scripts/VERSION'), '0.1.27\n');
    rmSync(join(source, 'reference/critique-rubric.md'));
    assert.throws(() => applyCodeflareImpeccableOverlay(source), /ENOENT/);
    assert.deepEqual([readFileSync(skillPath), readFileSync(browserPath)], before);
  }));

  for (const version of ['4.8.0', '4.9.1', '4.10.0']) {
    it(`REQ-AGENT-181 / REQ-AGENT-194: ${version} projection retains version and redistribution license/notices`, () => withTempDir(root => {
      const source = join(root, 'source');
      copyReviewedFixture(version, source);
      applyCodeflareImpeccableOverlay(source);
      const target = join(root, 'projected');
      replaceImpeccableTargets(source, readFileSync(join(source, 'SKILL.md'), 'utf8'), [{
        agent: 'pi', root: target, runtimePath: '~/.pi/agent/skills/impeccable',
      }]);
      const skill = readFileSync(join(target, 'SKILL.md'), 'utf8');
      assert.equal(skill.match(/^version: (.+)$/m)?.[1], version);
      for (const name of ['LICENSE', 'NOTICE.md']) {
        if (version === '4.10.0' && name === 'NOTICE.md') {
          assert.equal(createHash('sha256').update(readFileSync(join(target, name))).digest('hex'), '01bf53e5d24d64e19e9e1c33b24c37cef0d314323df7bf678c6ba22d4528a115');
          continue;
        }
        assert.equal(readFileSync(join(target, name), 'utf8'), readFileSync(join(repoRoot, 'host/__fixtures__/impeccable-4.7.0', name), 'utf8'),
          'the reviewed redistribution license/notices remain present');
      }
    }));
  }

  it('REQ-OPS-020 / REQ-AGENT-181: an unreviewed bundle identity or substituted bytes fail closed', async () => {
    for (const version of ['4.8.0', '4.8.2', '4.9.1', '4.10.0']) {
      assert.throws(() => verifyReviewedImpeccableBundle(Buffer.from('substituted release'), version), /differs from the reviewed release/);
    }
    assert.throws(() => verifyReviewedImpeccableBundle(Buffer.from('unreviewed release'), '4.8.1'), /bundle is not reviewed/);
    await assert.rejects(updateImpeccableSkill('4.8.1'), /bundle is not reviewed/);
    await assert.rejects(updateImpeccableSkill('__proto__'), /bundle is not reviewed/);
  });

  it('REQ-AGENT-181: native launcher uses only the image engine and refuses runtime updates', () => {
    withTempDir((root) => {
      const scripts = join(root, 'skill', 'scripts');
      const engine = join(root, 'engine', '0.1.5');
      mkdirSync(scripts, { recursive: true });
      mkdirSync(engine, { recursive: true });
      const launcher = join(scripts, 'impeccable');
      writeFileSync(launcher, managedImpeccableLauncher(join(root, 'engine')), { mode: 0o755 });
      writeFileSync(join(scripts, 'VERSION'), '0.1.5\n');
      writeFileSync(join(engine, 'impeccable'), '#!/bin/sh\nprintf "%s\\n" "$IMPECCABLE_SKILL_DIR" "$IMPECCABLE_SELF" "$@"\n', { mode: 0o755 });
      const result = spawnSync(launcher, ['context', '--target', 'a file.ts'], { encoding: 'utf8', env: { ...process.env, IMPECCABLE_BIN: '/does/not/exist' } });
      assert.equal(result.status, 0);
      assert.deepEqual(result.stdout.trim().split('\n'), [join(root, 'skill'), launcher, 'context', '--target', 'a file.ts']);
      for (const args of [['install'], ['update'], ['uninstall'], ['link'], ['skills', 'install'], ['skills', 'update'], ['skills', 'link']]) {
        const denied = spawnSync(launcher, args, { encoding: 'utf8' });
        assert.equal(denied.status, 1, args.join(' '));
        assert.equal(denied.stdout, '');
        assert.match(denied.stderr, /image-owned/);
      }
      rmSync(join(engine, 'impeccable'));
      const missing = spawnSync(launcher, ['context'], { encoding: 'utf8' });
      assert.equal(missing.status, 127);
      assert.match(missing.stderr, /missing from this Codeflare image/);
    });
  });

  it('REQ-AGENT-181: updater overlay fails before mutating a partial source', () => withTempDir((source) => {
    cpSync(skillRoot, source, { recursive: true });
    const skillPath = join(source, 'SKILL.md');
    const before = readFileSync(skillPath, 'utf8');
    writeFileSync(join(source, 'reference/audit.md'), 'incomplete upstream file\n');

    assert.throws(
      () => applyCodeflareImpeccableOverlay(source, { allowAlreadyApplied: true }),
      /audit/i,
    );
    assert.equal(readFileSync(skillPath, 'utf8'), before);
  }));

  it('REQ-AGENT-181: updater rejects a missing deletion anchor before mutation', () => withTempDir((source) => {
    cpSync(skillRoot, source, { recursive: true });
    const auditPath = join(source, 'reference/audit.md');
    const before = readFileSync(auditPath, 'utf8');

    assert.throws(() => applyCodeflareImpeccableOverlay(source), /SKILL\.md/);
    assert.equal(readFileSync(auditPath, 'utf8'), before);
  }));

  it('REQ-AGENT-181: malformed routing metadata leaves targets unchanged', () => withTempDir((root) => {
    const target = join(root, 'target');
    mkdirSync(target);
    const sentinel = join(target, 'sentinel.txt');
    writeFileSync(sentinel, 'preserve me\n');

    assert.throws(
      () => replaceImpeccableTargets(join(root, 'source'), 'malformed skill\n', [{
        agent: 'claude',
        root: target,
        runtimePath: '~/.claude/skills/impeccable',
      }]),
      /frontmatter/i,
    );
    assert.equal(readFileSync(sentinel, 'utf8'), 'preserve me\n');
  }));

  it('REQ-AGENT-181: missing mutable package permission leaves targets unchanged', () => withTempDir((root) => {
    const target = join(root, 'target');
    mkdirSync(target);
    const sentinel = join(target, 'sentinel.txt');
    writeFileSync(sentinel, 'preserve me\n');
    const skill = '---\ndescription: upstream\nallowed-tools:\n  - Bash(node scripts/*)\n---\nbody\n';

    assert.throws(
      () => replaceImpeccableTargets(join(root, 'source'), skill, [{
        agent: 'claude',
        root: target,
        runtimePath: '~/.claude/skills/impeccable',
      }]),
      /mutable package permission/i,
    );
    assert.equal(readFileSync(sentinel, 'utf8'), 'preserve me\n');
  }));
});
