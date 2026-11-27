# Terminal & IDE

Browser terminal and editor client contracts, mobile compatibility, viewport ownership, and connection recovery.

**Audience:** Developers, Operators

**Owns:** terminal surfaces/protocol/client visibility and focus; mobile keyboard/touch/fit/scroll compatibility; Browser IDE workspace behavior, public proxy contract, editor continuity boundaries and device verification. **Does not own:** D1 lifecycle/process-exit authority, container supervision/idle enforcement, durable file reconciliation, credential containment, Browser Run automation, or IDE package implementation inventory.

## Contents

- [Terminal ownership and transport](#terminal-ownership-and-transport)
- [GitHub and Storage workspace](#github-and-storage-workspace)
- [Backend state and client connectivity](#backend-state-and-client-connectivity)
- [Browser IDE](#browser-ide)
- [Interaction and Focus Model](#interaction-and-focus-model)
- [Terminal Compatibility](#terminal-compatibility)
- [Scroll Stability](#scroll-stability)
- [Transport Recovery](#transport-recovery)
- [Behavioral Test Matrix](#behavioral-test-matrix)
- [GitHub workspace acceptance](#github-workspace-acceptance)
- [Requirement and Source Map](#requirement-and-source-map)
- [Terminal manual qualification](#terminal-manual-qualification)
- [Related Documentation](#related-documentation)

## Terminal ownership and transport

The persisted per-session terminal stamp is immutable. Classic owns Codeflare tabs/labels/layouts/tiling and up to six outer node-pty sessions; Herdr owns inner tabs/panes/splits/workspaces/agents behind one xterm surface, outer terminal ID `1`. Historical missing/invalid mode resolves Classic; preferences affect only new sessions. Dashboard opens no new terminal surface; VS Code has none. MultiView is browser-local virtual workspace membership, never a backend identity or capacity/storage API argument. [REQ-TERM-001](../../sdd/spec/terminal.md#req-term-001-terminal-surface-count-follows-session-mode), [REQ-TERM-034](../../sdd/spec/terminal.md#req-term-034-terminal-mode-assignment-is-immutable).

`/api/terminal/{sessionId}-{terminalId}/ws` remains the existing authenticated Worker→DO→host transport. PTY output is raw, with typed JSON control frames for resize/process name/restore/kill and notification coordination. No application ping/pong or browser Herdr protocol is added. [REQ-TERM-002](../../sdd/spec/terminal.md#req-term-002-websocket-connection-to-container-pty) owns Herdr outer-ID rejection and the Enterprise same-owner/generation reconnect fence. See also [API](api-reference.md) and [Security](security.md). See [REQ-TERM-019](../../sdd/spec/terminal.md#req-term-019-terminal-websocket-control-frames-and-protocol-guards).

Dashboard opens no terminal sockets, but can retain one already-connected untiled Classic or single Herdr pane without allowing hidden input, resize, or reconnect. Single-session Classic exposes its active tabs or tiles, Herdr one surface, and MultiView one outer surface per member. <!-- @impl: web-ui/src/components/TerminalArea.tsx::TerminalArea --> Leaving the visible set disposes non-retained panes without killing their PTYs. Focus handoff does not remount/reconnect; focused visible pane claims resize authority before publishing fitted dimensions. Stale cleanup cannot close a newer owner; losing focus before open clears pending resize authority. Herdr visibility return forces current-pane repaint with same-size resize even if dimensions did not change. [REQ-TERM-011](../../sdd/spec/terminal.md#req-term-011-visible-terminal-panes-own-websocket-connections), [REQ-TERM-016](../../sdd/spec/terminal.md#req-term-016-terminal-pane-reconnect-and-resize-authority), [REQ-TERM-017](../../sdd/spec/terminal.md#req-term-017-multiview-pane-focus-and-input-routing).

A Host-confirmed Vibe-to-Code handoff may attach or reconnect only one rendered destination pane in the current session and generation. Until reveal, it sends no input, focus, or resize frames. See the [tiled handoff regression](../../web-ui/src/__tests__/components/Layout.test.tsx). <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @impl: web-ui/src/stores/terminal.ts::connect -->

At `mounting` the visible pane initiates one attachment lifecycle; it does not bypass public endpoint readiness. The endpoint returns retryable 1013 before the terminal service is ready and does not assign a PTY. See [REQ-TERM-046](../../sdd/spec/terminal.md#req-term-046-visible-terminal-startup-connection) for mounting behavior; it does not establish endpoint authority.

The store publishes Ready only after confirming the completion still belongs to the current Start. <!-- @impl: web-ui/src/stores/session.ts::startSession --> The single-pane Terminal keeps showing startup progress until that pane’s browser socket is connected. Focus and display await OPEN, which reveals and focuses the same mounted pane without reconnecting it. Foreign panes are unchanged. [REQ-TERM-043](../../sdd/spec/terminal.md#req-term-043-visible-terminal-readiness-gating) owns OPEN display and focus.

OPEN still renders the selected pane before viewport dimensions are known. Genuine PTY reattachment first restores the host serialized screen. [REQ-TERM-044](../../sdd/spec/terminal.md#req-term-044-terminal-restore-and-readiness-rendering) owns restore/rendering obligations.

Browser Back or Dashboard during terminal startup selects a usable dashboard independently of any session's initialization latch. Startup and its progress/OPEN ownership continue in the background; returning restores the progress/ready surface without another Start or Stop. Background completion/failure cannot hide Dashboard or steal selection. <!-- @impl: web-ui/src/components/TerminalArea.tsx::TerminalArea --> [REQ-SESSION-037](../../sdd/spec/session-lifecycle.md#req-session-037-dashboard-navigation-remains-available-during-startup).

Herdr image settings manage mobile layout, mouse capture, browser-owned clipboard, 10 MB pane scrollback, palette, labels and static status symbols. Updates, remote manifests, sound, pane history persistence, nested launches and Kitty graphics stay disabled. Named runtime lifetime/readiness/recovery belongs to [Sessions & Runtime](container.md#runtime-lifecycle); normal [Storage & Sync](storage-and-sync.md) retains the structural `session.json` and the current Herdr session’s exact Pi `agent-session-id` under private home metadata ([REQ-TERM-033](../../sdd/spec/terminal.md#req-term-033-durable-herdr-structural-session-recovery)). Pane output and arbitrary processes do not survive. Fresh Herdr Pi runs fullscreen and owns its transcript.

### Pi Chat handoff acceptance

[REQ-AGENT-272](../../sdd/spec/agents.md#req-agent-272-pi-chat-and-terminal-transcript-handoff) treats Chat and Classic Terminal as alternate writers for one native transcript. Herdr stays on its native Terminal path; its Chat handoff is deferred. Browser VS Code owns its own Pi and is not part of the switch. These steps require an authorized disposable workspace and the packaged feature head; a passing stock transcript interoperability check alone is not full acceptance.

| Criteria | Procedure |
|---|---|
| Classic Start and Resume | [Choose the starting writer](#choose-the-starting-writer). |
| Transcript continuity and stop | [Switch one writer at a time](#switch-one-writer-at-a-time). |
| Native quit and re-entry | [Quit and reopen native Pi](#quit-and-reopen-native-pi). |
| Panel geometry | [Check desktop and mobile layout](#check-desktop-and-mobile-layout). |
| Passive clients and stock controls | [Check stale frames and native questions](#check-stale-frames-and-native-questions). |

[Pi Web image prewarm](container.md#stock-pi-web-and-the-native-pi-writer) timings do not measure browser readiness or time to **Open**.

#### Choose the starting writer

[REQ-AGENT-275](../../sdd/spec/agents.md#req-agent-275-classic-pi-chat-startup) covers startup and frame recovery.

In **Vibe**, Dashboard **New Session** starts Pi Chat directly. Returning to Dashboard does not unlock another direct launch until the first Start settles or you stop it. Existing creation limits still apply. See [REQ-AGENT-279](../../sdd/spec/agents.md#req-agent-279-direct-vibe-session-launch).

- When the picker is available, choose Vibe or Code in the header before using a Dashboard card. The card menu retains lifecycle actions but has no Chat or Terminal override ([REQ-AGENT-276](../../sdd/spec/agents.md#req-agent-276-vibe-and-code-workspace-preference), AC5).
- For [REQ-TERM-049](../../sdd/spec/terminal.md#req-term-049-shared-workspace-startup-progress), check that **Syncing workspace** stays active through verification, then advances to **Preparing environment**.
- While waiting for Open, Vibe shows **Loading Chat** with the same one-decimal elapsed timer as the other startup steps and a loading icon that spins with default motion.
- With a non-green theme accent, check the final startup row, not the subtitle. For **Loading Chat**, expect accent text and a muted-accent icon background.
- When **Open** appears, the row still says **Loading Chat** with its final elapsed time, success text, and a muted-success icon background.
- Repeat with reduced motion enabled: the timer still advances, but the icon does not spin.
- Code shows **Connecting Terminal**. Only when Open is available does the final step say **Ready to open**.
- In Standard and Pro where available, start Chat-first and Terminal-first in Classic. Send a synthetic message, Stop normally, then resume in the other surface. Only the selected primary opens the saved conversation.
- On a disposable account with no saved surface preference, start a stopped Classic Pi session from its card without choosing a mode.
- Save **Vibe**, then set **VS Code** as the default workspace. Confirm the mode picker is hidden and restart the same stopped Classic Pi session, not a new VS Code session.
- In both runs, verify **Loading Chat** never appears and **Open** reveals the already-mounted Terminal.
- The [Layout regression](../../web-ui/src/__tests__/components/Layout.test.tsx) checks that the startup UI stays mounted while the first Host status is pending ([REQ-TERM-043 AC6](../../sdd/spec/terminal.md#req-term-043-visible-terminal-readiness-gating)). It uses a mock Terminal and does not track sockets.
- On Chat-first Start and Resume, verify the stock frame loads behind the startup overlay. Once the Host confirms Chat and five seconds have passed since the stock loader disappeared, **Open** becomes available on a best-effort basis.
- After **Open** appears, wait over 25 seconds before clicking it. Verify it reveals the same frame without starting native Pi.
- For each run below, configure an authorized synthetic repository as a restore target and ensure its checkout is absent locally.
- Start Chat-first and choose **Open**. While **Restoring repositories…** is visible, verify the Chat composer works, then switch **Chat → Terminal** before waiting for the clone outcome.
- In a separate Terminal-first run, choose **Open**. While **Restoring repositories…** is visible, verify native Pi accepts a harmless prompt, then switch **Terminal → Chat**.
- For each direction, record notice transitions as they happen; a success notice clears after five seconds. Confirm the destination answers a harmless prompt while the restore notice remains visible through the switch. <!-- @impl: web-ui/src/stores/session.ts::watchRepositoryRestore = 5_000 -->
- Mark only that direction unexercised if you observe a restore outcome before the reply. A notice disappearing while restore is still active is a failure, not evidence of completion.
- If the destination replies first, keep observing. Record **Repositories restored**, **Some repositories weren’t restored**, or no observed outcome. Disappearance alone proves neither outcome. See [REQ-GITHUB-320 AC2–3](../../sdd/spec/github.md#req-github-320-nonblocking-terminal-repository-restore-notice). <!-- @impl: web-ui/src/components/Layout.tsx::Layout -->
- In a disposable browser check, block the first Chat frame navigation before it reaches the Host. Clear the block and choose **Reload Chat**. Verify the same conversation opens without a second handoff.
- Verify unchanged workspace defaults, manually opened panes, and independent Browser VS Code behavior.

#### Switch one writer at a time

[REQ-AGENT-273](../../sdd/spec/agents.md#req-agent-273-pi-handoff-continuity) covers stopping feedback, no replay, and draft recovery.

- Switch both ways in an empty and a populated conversation, then repeat from an earlier tree leaf. The native ID and branch match; the previous writer exits first. A failed open cannot replace the conversation.
- Record matching identities as equality results. Do not record actual transcript IDs, paths, or content.
- Start Chat-first and switch after prewarm orphan expiry without previously opening Terminal. The healthy primary is still available without counting as user activity. A secondary Classic Pi tab owns a different conversation.
- Switch during streaming, a queued follow-up, and a pending question. Expect the destination label to shuffle without extra text, a spinner, or **Cancel switch** in the mode menu. With reduced motion, the label stays static.
- With a screen reader, verify the pending destination is announced once without reading the scrambled characters.
- During the switch, verify automatic native Abort and rejection of fresh prompts.
- For [REQ-AGENT-280](../../sdd/spec/agents.md#req-agent-280-attachment-gated-workspace-reveal), keep the outgoing view until Code connects or Vibe clears the stock loader. A native startup question can appear early.
- During Code-to-Vibe handoff, fail the first destination frame navigation. Verify Vibe reveals **Reload Chat** before normal readiness, then clear the failure and reload the same conversation without a new handoff.
- The workspace mode menu does not offer browser cancellation.
- The [Host test](../../host/__tests__/pi-web-handoff.test.js) holds the request before Abort and verifies whether the turn survives ([REQ-AGENT-272](../../sdd/spec/agents.md#req-agent-272-pi-chat-and-terminal-transcript-handoff) AC6).
- The [Layout test](../../web-ui/src/__tests__/components/Layout.test.tsx) simulates `waiting` and verifies the source remains mounted without **Cancel switch** in the mode menu ([REQ-AGENT-280](../../sdd/spec/agents.md#req-agent-280-attachment-gated-workspace-reveal) AC3).
- Repeat with an input hook held before streaming. Neither an idle-looking status nor an Abort acknowledgment can transfer ownership while the hook is active.
- Verify saved history appears without automatic prompt or queue replay. Text recovered by Abort returns to Terminal as an editable, unsent draft.

#### Return from Profile Usage

1. With Chat visible, identify its iframe in Chrome DevTools and note its node and generation for comparison. Start recording Network requests.
2. From the workspace header, choose **Profile → Usage** without going through Dashboard. Verify the original frame stays mounted but hidden. Click **Back to Dashboard** and verify the frame is still parked.
3. Open the same running session. Verify it reveals the original node and generation, with no `POST` to `/_switch` during the round trip. Read-only status requests are allowed. Record only equality and whether the POST occurred ([REQ-AGENT-277 AC3](../../sdd/spec/agents.md#req-agent-277-retained-chat-on-dashboard-return)).
4. Separately open **Profile → Usage** from Dashboard. Verify the Profile overlay disappears and **Back to Dashboard** remains usable ([REQ-AUTH-016 AC6](../../sdd/spec/authentication.md#req-auth-016-header-user-dropdown)).

#### Quit and reopen native Pi

- Quit Pi normally and run a harmless command in the same Terminal shell. Run the printed restart command there without opening Chat. The same transcript and branch reopen under a fresh writer, without replay.
- Repeat the quit, switch to Chat after Pi exits, then switch back. When **Retry switch** appears, run the printed command in the original pane, then select **Retry switch**. The same conversation reopens without replay.
- Use the [packaged Host handoff smoke](../../scripts/ci/smoke-pi-web-host-handoff.mjs) for the rapid-return race. It keeps the retiring registration live, then checks that the grant is unchanged and the attempt remains retryable. A manual timing attempt does not replace this check.
- The [packaged launcher smoke](../../scripts/ci/smoke-pi-web-launchers.mjs) interrupts a pending launch, verifies a late claim cannot use the revoked grant, and reopens the transcript with a fresh invocation. It also verifies that a claim which won first prevents replacement.

#### Verify SYSTEM rows are hidden in Chat

For [REQ-AGENT-282](../../sdd/spec/agents.md#req-agent-282-stock-pi-chat-navigation-and-footer-defaults), the [stock browser fixture](../../scripts/ci/smoke-pi-web-system-rows.mjs) checks both SYSTEM row shapes and ordinary user and assistant rows. It does not test durable storage or a live producer.

- **Saved history:** Read the JSONL of a disposable conversation with a known, non-sensitive SYSTEM marker and ordinary replies. Do not edit the transcript or open a second writer.
- Reload the page and reopen the same conversation. In DevTools, match the marker in the fresh `transcript-snapshot` response for that session. Revealing a retained frame does not qualify.
- Read the JSONL again to confirm the same entry remains. Compare the entry, not the line count.
- **Live event prerequisite:** No repeatable, safe hosted producer is established. Record the live case as unexercised unless a supported disposable trigger and its delivery are observed.
- **Live event capture:** Start DevTools Network recording before opening Chat. After a supported trigger, match the marker in the session `/events` WebSocket messages without reloading or reopening. Confirm the entry separately in JSONL.
- In both cases, ordinary replies must remain visible and the entire SYSTEM row must be hidden. Mark cases unexercised if you cannot verify delivery or the required fresh load.
- **Native dialog:** Use [native questions](#check-stale-frames-and-native-questions) to verify that an independent dialog can still open and be answered.

#### Check desktop and mobile layout

Use these checks for [REQ-AGENT-272](../../sdd/spec/agents.md#req-agent-272-pi-chat-and-terminal-transcript-handoff).

- With Vibe Chat open, compare the outer iframe and the single Codeflare session header. Their left and right edges match, the header sits immediately above the frame, and the pair is centered in the workspace.
- After subtracting the header height, allow 1440 × 900 CSS px and expect an 800 × 720 frame at rest. Repeat with 900 × 1600 CSS px and expect 720 × 1200. Together these exercise the percentage and both caps.
- At 640 CSS px viewport width, verify the header and frame fill the width and Chat fills the remaining height with no outer gutter, border, or rounding. At 641 px, verify the phone override no longer applies.
- Above the phone breakpoint, compare workspace widths of 760 and 761 CSS px at a height above 480 px. Expect 12 px gutters plus safe-area insets at 760 px and proportional sizing at 761 px.
- With workspace width above 760 px, compare workspace heights of 480 and 481 CSS px. Expect gutters at 480 px and proportional sizing at 481 px. Both cases retain the size caps.
- In the narrower header, verify Profile overflow actions and keyboard focus remain usable. Select Code and verify focus returns to the same mode trigger once Code attaches.
- Confirm the composer and controls stay reachable without a second page scrollbar at rest, with the mobile keyboard open, and with browser zoom.
- Confirm the regular Dashboard, startup, and Code/Terminal layouts are unchanged. On returning to the same running Chat from Dashboard, confirm it reappears in the panel without reloading.
- For [REQ-AGENT-282 AC3](../../sdd/spec/agents.md#req-agent-282-stock-pi-chat-navigation-and-footer-defaults), verify token and context usage remain visible without a USD amount.
- On a disposable session, queue a harmless message during a turn and verify the nonzero queued count remains visible. Repeat the footer check with a different stock theme.
- In a fresh browser context, verify the machine name defaults to **Codeflare** and the theme is **Pi Web Classic**. Save a different theme, then reopen Chat in that browser and verify the choice was preserved.

#### Check stale frames and native questions

- Keep an old frame open during Terminal ownership. Refresh and reconnect its event socket; neither action can acquire a writer. A stale prompt cannot run. Worker tests separately exercise cross-owner and CSRF rejection.
- Stop the session without resuming. Repeat the refresh and reconnect while stopped. No replacement starts and the generation stays unchanged. Resume Chat and repeat with the old frame while the same transcript is active in the new generation.
- For [REQ-AGENT-274](../../sdd/spec/agents.md#req-agent-274-stock-pi-chat-controls), open a harmless file through Files, then select it with `@`. Quiet starts on and can be changed. Chat has no Git or worktree controls; ordinary Terminal and VS Code Git still work.
- Use a disposable managed-adapter profile and fresh Pi Web runtime data. Before startup, append `/opt/codeflare/pi-web/node_modules/@jmfederico/pi-web/dist/pi-packages/workflows` to the restored profile’s `~/.pi/agent/settings.json` `packages` array, keeping existing entries. See the [stock service fixture](../../scripts/ci/smoke-pi-web-services.mjs).
- Start Vibe and verify Chat opens with that restored profile ([REQ-AGENT-272 AC7](../../sdd/spec/agents.md#req-agent-272-pi-chat-and-terminal-transcript-handoff)).
- From first visible Chat render and again after returning from Dashboard to the same session, check Git navigation and the composer’s command picker. Any appearance of Git navigation or `/worktree` fails ([REQ-AGENT-274](../../sdd/spec/agents.md#req-agent-274-stock-pi-chat-controls)).
- Use the synthetic confirmation fixture below. During Chat opening, leave **Resume the Pi handoff smoke transcript?** unanswered for over 25 seconds. Verify it remains answerable and **Open** is absent. Choose **Yes** and verify `pi-fixture-opening-yes.txt` appears and the same frame reaches **Open**.
- The [packaged Host smoke](../../scripts/ci/smoke-pi-web-host-handoff.mjs) separately checks the timeout exception, original answer delivery, and writer fence. It does not exercise browser visibility.
- Once Chat is ready, submit `pi-fixture-question`. Choose **Yes** on **Continue the ready Chat fixture?**. Verify `pi-fixture-ready-yes.txt` appears without a model turn. Then send a separate harmless prompt and verify the composer works.
- In the ready Chat composer, use **Save to …** with synthetic attachments totaling 10 MB (10,000,000 bytes). Verify that the files land in the selected workspace folder.
- Repeat with a batch one byte larger, then with 17 small attachments. Confirm that neither rejected batch saves any files.
- Verify Chat and Files remain available and Info, Updates, MCP Manager, Tasks, and Relays are absent from stock navigation. This does not verify MCP configuration.
- For [REQ-AGENT-282 AC1–2](../../sdd/spec/agents.md#req-agent-282-stock-pi-chat-navigation-and-footer-defaults), use a fresh browser and verify only Chat and Files are pinned on desktop and phone.
- Change the pins and reopen Chat in the same browser to verify the saved choices win. Stock Navigation can re-pin Terminal or mobile Sessions; the default does not disable the required Terminal plugin.
- Recovering an already-pending question after refresh is not required. For a [recoverable initial Chat service failure](../../sdd/spec/agents.md#req-agent-283-initial-chat-service-recovery), retry the same transcript only after the previous attempt is confirmed closed.

Workspace attachments survive Stop and Resume only with [full Workspace Sync](storage-and-sync.md#rclone-sync-modes-req-stor-003) and a successful sync. For independent persistence, use **Dashboard → Storage → Uploads**, then **Sync now** to read the files in `~/Uploads` in the running session.

The [packaged Host handoff smoke](../../scripts/ci/smoke-pi-web-host-handoff.mjs) exercises a successful 10,000,000-byte batch and rejects an extra byte, 17 files, and a request body above 14 MiB before writing files. It does not exercise browser submission.

The [stock supervisor smoke](../../scripts/ci/smoke-pi-web-services.mjs) checks disabled plugins and runs [package reconciliation](mcp.md#client-configuration-and-migration) on a restored profile fixture before opening stock Chat. It verifies adapter preparation, no handoff warning, and a catalog request to a synthetic MCP server. It does not run full container startup or invoke an MCP tool.

The [supervisor-only smoke case](../../scripts/ci/smoke-pi-web-services.mjs) re-adds the bundled Manager after reconciliation and starts the supervisor without reconciling again. The supervisor preserves the registration, and the Pi config handoff extension reports ambiguity without changing the adapter config.

In the disposable workspace only, load the following as `handoff-fixture.ts` in the Pi agent’s `extensions` directory before opening Chat. It uses the same startup confirmation as the [packaged stock smoke](../../scripts/ci/smoke-pi-web-handoff.mjs) and adds the ready-state trigger. Start with both marker files absent; remove the fixture and marker files afterwards.

```ts
import { writeFile } from 'node:fs/promises';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
export default function (pi: ExtensionAPI) {
  const mark = (cwd: string, name: string) => writeFile(`${cwd}/${name}`, 'yes\n', { flag: 'wx' });
  pi.on('session_start', async (_event, ctx) => {
    if (ctx.mode === 'rpc' && await ctx.ui.confirm('Resume the Pi handoff smoke transcript?', 'Continue without a model turn.'))
      await mark(ctx.cwd, 'pi-fixture-opening-yes.txt');
  });
  pi.on('input', async (event, ctx) => {
    if (ctx.mode !== 'rpc' || event.text !== 'pi-fixture-question') return;
    if (await ctx.ui.confirm('Continue the ready Chat fixture?', 'Handle this input without a model turn.'))
      await mark(ctx.cwd, 'pi-fixture-ready-yes.txt');
    return { action: 'handled' };
  });
}
```

#### Future Herdr handoff qualification

Herdr Chat is not part of the current delivery. The [launcher fixture](../../host/__tests__/herdr-launcher.test.js) supplies an available pane: bootstrap completes without a direct `pane run … pi` command. The fixture does not run the writer wrapper. Delayed-pane readiness and the absence of a native writer remain unverified; no verification method is available for these checks.

The restore checks below apply only if Herdr handoff is enabled in a future release.

- For [REQ-TERM-048](../../sdd/spec/terminal.md#req-term-048-managed-herdr-pi-writer-restore), Stop a live managed Herdr writer, then repeat with one already parked. Confirm the original pane retains the wrapper role.
- Restore with a different pane focused. The writer returns to the original pane. A legacy snapshot with no verified role restores its native Terminal and refuses Chat.

### Browser terminal link activation

OAuth shims print URLs rather than opening container browsers. The shared xterm link provider owns detection, reconstruction and browser opening. Classic retains activation; Herdr Ctrl-/Cmd-click and stationary mobile link taps open once without SGR input. Same-cell pointer jitter is allowed; moving cells cancels modified activation. Mobile link taps do not focus input or reset fullscreen history. Modified non-links still reach Herdr. Focused connected pane owns URL detection; cleanup is scoped to that session/terminal, never unscoped on ordinary unmount. <!-- @impl: web-ui/src/lib/terminal-link-provider.ts::registerMultiLineLinkProvider --> [REQ-TERM-015](../../sdd/spec/terminal.md#req-term-015-focused-pane-owns-url-detection), [REQ-TERM-042](../../sdd/spec/terminal.md#req-term-042-browser-terminal-link-activation).

Terminal links exclude unmatched trailing closing parentheses from both the destination and clickable range, preserving balanced and percent-encoded parentheses. The existing desktop and touch auth-link controls also recognize `auth.openai.com` regardless of path. <!-- @impl: web-ui/src/stores/terminal-url-detection.ts::isActionableUrl --> [REQ-TERM-042](../../sdd/spec/terminal.md#req-term-042-browser-terminal-link-activation).

### Terminal evidence boundaries

Component/store [classic-surface](../../sdd/spec/terminal.md#req-term-007-classic-topology-remains-available) and [MultiView focus/input](../../sdd/spec/terminal.md#req-term-017-multiview-pane-focus-and-input-routing) tests are controlled methods, not proof of physical terminal/editor retention or hosted browser acceptance. Source and dependency inspection supports ownership/compatibility judgment, not executed process or socket lifetime. Keep those evidence populations distinct.

### Terminal snapshot restoration acceptance

Use an already-authorized disposable terminal with bounded synthetic output. Interrupt only its browser transport while the host continues, then reconnect through the normal UI without restarting the process. Pass when the authoritative host screen replaces prior client content without duplication, returns to the live bottom and drops the old selection/viewport while tabs, tiling and any external editor remain intact. Exercise Classic and Herdr separately; retain only outcome booleans, not terminal contents. Missing authorized transport controls make the observation unavailable.

For REQ-IDE-063 AC3, retain an already-open external editor during the same authorized transport interruption. If the current client exposes a reconnection countdown, observe through its expiry before reconnecting: neither socket loss nor that client-only expiry may close/recreate the editor window or establish server-stopped authority. Reconnect normally and confirm the same editor remains usable. Do not manipulate clocks or prolong an outage without authorization; absent countdown or editor observations leave that case unverified.

Supplemental automated coverage remains in [container index](../../src/__tests__/container/index.test.ts), [terminal WebSocket](../../src/__tests__/routes/terminal-ws.test.ts), [session presentation](../../web-ui/src/__tests__/lib/session-presentation.test.ts), [session store](../../web-ui/src/__tests__/stores/session.test.ts), [TerminalArea](../../web-ui/src/__tests__/components/TerminalArea.test.tsx), and [workspace lifecycle](../../web-ui/src/__tests__/components/workspace-lifecycle.test.tsx) tests. These do not replace the manual observation above.

### MultiView focus continuity acceptance

Use two already-authorized connected MultiView panes and existing browser network inspection. Record connection identity and open/close counts, not headers or terminal payloads. Switch focus by click and touch; confirm both panes continue receiving output and benign input reaches only the focused pane. Pass only when the same pane surfaces and connections remain live without a new handshake or close. Missing authorized browser observations are unavailable evidence; this method does not authorize creating sessions or running a new harness.

### Herdr clipboard compatibility boundary

Explicit copy uses OSC 52 standard `c` selector, valid base64/UTF-8, at most 64 KiB decoded. Reads/queries/invalid selectors/encoding/oversize are rejected. Herdr copy is independent of Classic right-click paste preference; Classic installs no Herdr write handler. Ctrl-/Cmd-V reads during trusted key gesture and pastes via xterm. Browser permission remains authoritative; content/queries are never logged and no second clipboard service exists. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @impl: web-ui/src/lib/osc52.ts::beginClipboardWrite -->

Samsung may reject asynchronous writes. The latest failure remains browser-local for the next trusted floating Paste control, which retries clipboard write and pastes retained text once. Older failure cannot overwrite newer state. Pi/Herdr copy toasts prove emission, not browser acceptance. <!-- @impl: web-ui/src/components/FloatingTerminalButtons.tsx::pasteFromClipboard --> [REQ-TERM-032](../../sdd/spec/terminal.md#req-term-032-herdr-clipboard-compatibility-boundary), [REQ-TERM-041](../../sdd/spec/terminal.md#req-term-041-rejected-herdr-clipboard-recovery).

### Herdr attention and completion

Managed Pi/Claude fixed events use bounded authenticated loopback ingress in Herdr when inner OSC bytes are unavailable; no prose/paths/credentials enter it. Classic keeps native producer behavior. Herdr completion uses semantic status for valid recognized Pi/Claude pane rows, private public-API socket subscriptions and one ten-minute all-idle/done timer after observed work. Working cancels timer/queued completion, not input-required events; blocked/unknown or initial-ready/no-agent state cannot trigger completion. No pane identity/socket path reaches browser; timer does not extend user activity/lifetime. Local/Push Pi copy is **Ready for input**, Claude remains **Task completed**. Classic has no completion producer. A valid snapshot envelope can omit malformed recognized-agent rows before aggregation; outer-frame failure handling does not establish row-complete status evidence. <!-- @impl: host/src/herdr-agent-status.ts::HerdrAgentStatusMonitor --> [REQ-TERM-029](../../sdd/spec/terminal.md#req-term-029-herdr-status-gated-terminal-completion), [REQ-TERM-031](../../sdd/spec/terminal.md#req-term-031-herdr-notification-compatibility-boundary), [REQ-TERM-038](../../sdd/spec/terminal.md#req-term-038-herdr-semantic-status-owns-completion-readiness), [REQ-TERM-039](../../sdd/spec/terminal.md#req-term-039-herdr-completion-delivery-is-readiness-oriented).

Notification delivery coordinates event-specific suppression, a single local grant, no-client fallback, acknowledgement/expiry and idle isolation. If client cancellation arrives during notification-worker lookup, the current path can still call `showNotification` after that lookup while withholding confirmation; [REQ-TERM-023 AC2](../../sdd/spec/terminal.md#req-term-023-away-only-agent-notification-delivery) distinguishes this local-display limitation from suppressed confirmation and fallback. Per-device enrollment alone requests permission. Existing Partial deployed notification verification remains Partial; this relocation does not supply acceptance evidence.

## GitHub and Storage workspace

In Code mode, the Dashboard right column shares space between GitHub and Storage: when space permits, GitHub anchors at the top and Storage at the bottom, with adaptive scrollable allocation rather than a fixed repository row limit. Only the mobile layout collapses to one content-sized, viewport-capped face. <!-- @impl: web-ui/src/components/Dashboard.tsx::flipBrowsers --> GitHub is the default when enabled; header controls flip to Storage and back, recomputing height. Disabled GitHub leaves Storage alone. <!-- @impl: web-ui/src/components/Dashboard.tsx::effectiveFace --> [REQ-GITHUB-009](../../sdd/spec/github.md#req-github-009-github-repository-list-viewport-and-empty-states), [REQ-GITHUB-010](../../sdd/spec/github.md#req-github-010-mobile-github-and-storage-face-switching), [REQ-GITHUB-012](../../sdd/spec/github.md#req-github-012-responsive-github-and-storage-panel-allocation).

For [REQ-GITHUB-002](../../sdd/spec/github.md#req-github-002-github-panel-and-repository-listing) AC4, the controls reuse one tested icon-button primitive, `IconButton`. <!-- @impl: web-ui/src/components/github/ConnectedHeader.tsx::ConnectedHeader --> <!-- @impl: web-ui/src/components/ui/IconButton.tsx::IconButton --> <!-- @test: web-ui/src/__tests__/components/GitHubPanel.test.tsx (GitHubPanel Component) --> <!-- @test: web-ui/src/__tests__/components/IconButton.test.tsx (IconButton) -->

Repository search is disclosed on demand at every breakpoint. Opening the magnify toggle reveals and synchronously focuses the input; touch also scrolls it above the keyboard. Closing hides the input and clears the filter, so hidden search cannot silently narrow the list. <!-- @impl: web-ui/src/components/github/GitHubPanel.tsx::toggleSearch --> [REQ-GITHUB-011](../../sdd/spec/github.md#req-github-011-mobile-search-disclosure-with-autofocus). Pixel allocation and protected-deployment viewport checks retain their manual qualifiers; source descriptions do not establish device acceptance.

On Dashboard return, the GitHub panel reuses its repository list and search. An unpaginated list may refresh quietly after five minutes; accumulated pages wait for explicit reload. A changed connection discards the prior account's repositories. This policy applies only to file and repository listings, not session status, readiness, or quota polling. <!-- @impl: web-ui/src/stores/github.ts::loadStatus -->

In Vibe, the [GitHub and Storage drawer](../../sdd/spec/github.md#req-github-321-vibe-dashboard-browser-disclosure) starts closed. Open it from the summary column’s right edge on desktop and tablet, or below Storage Usage on mobile. The same control closes both browsers. <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard -->

### Workspace header acceptance

[REQ-AGENT-278](../../sdd/spec/agents.md#req-agent-278-narrow-workspace-header-fallback) covers dropdown placement and the second-row fallback. On both Dashboard and workspace, check that the dropdown sits immediately before Profile on desktop and tablet, whether it shows text or an icon.

Try a tablet viewport such as 960px. In Vibe, open and close the Dashboard drawer to vary the header width without changing the viewport. Verify the label appears when it fits and the icon replaces it when it does not.

Open the dropdown and verify **Vibe Mode** and **Code Mode**, with an accent-filled background only on the active choice and no “(Current)” suffix. With forced colors active, confirm the checkmark still distinguishes the active choice. In a running Pi workspace, switch modes and confirm the menu shows pending progress. When the destination activates, the menu closes and focus returns to its trigger.

For [REQ-AGENT-276 AC2](../../sdd/spec/agents.md#req-agent-276-vibe-and-code-workspace-preference), select the other mode on Dashboard. Confirm Dashboard stays open and no session starts. Reload Dashboard and confirm the selected default persists.

At 390px verify the icon-only dropdown sits before Profile and opens the same choices. Separately, on desktop, narrow the Dashboard card until the text no longer fits; the icon should replace it, and the label should return when it fits again.

Use an authorized running Enterprise workspace with the mode selector, VS Code, Vault, and the sleep countdown visible.

Narrow the viewport and verify VS Code, then Operators, then Vault enter Profile as needed. Open Profile and check each moved action remains reachable. See [Operators](../../sdd/spec/operators.md#req-operator-040-owned-activity-control-presentation) and [Vault](../../sdd/spec/vault.md#req-vault-033-vault-button-availability-and-opening).

For [REQ-AUTH-016 AC4 and AC7](../../sdd/spec/authentication.md#req-auth-016-header-user-dropdown), open Profile in both headers above 640 CSS px. Measure from the Profile button’s bottom edge: without email, 60px anchors the menu and 59px uses the bottom sheet. With email, add the rendered label height and gap to both thresholds. Use a wrapping address near 640px and resize with the menu open: the full black label stays above the actions without widening their panel, and a short viewport uses the bottom sheet. Repeat both threshold cases between 640px and 641px, using browser zoom if needed. Confirm `matchMedia('(640px < width < 641px)').matches` before counting each result. Check the rendered placement, not just the menu class.

For [REQ-AUTH-016 AC5](../../sdd/spec/authentication.md#req-auth-016-header-user-dropdown), reduce height on desktop and mobile in both headers until the last action starts below the visible menu area. Verify the menu stays inside the viewport and scrolling it reveals the last action fully without scrolling the page. Mark any placement or scrolling case that cannot be reproduced as unverified.

At 375px, verify Settings is reachable and the groups retain the one-slot gap. Continue narrowing after overflow is exhausted until the utilities move to a second row. Verify every remaining action is reachable and each icon target measures 44 × 44 CSS px. Mark wrapping unverified if the fallback never appears.

### Vibe drawer acceptance

In both Vibe and Code, measure the **+ New Session** button on desktop, tablet, and mobile. Verify its wrapper adds half the rendered button height as bottom padding. For the error-only case, use an authorized test setup with GitHub disabled and simulate a denied callback by opening `/app/?github=denied` in Vibe. Verify the denial is visible and the normal GitHub card is absent before measuring. If that setup is unavailable, record the case as unexercised.

Use an authorized account with GitHub enabled and select **Vibe**. Check [drawer disclosure](../../sdd/spec/github.md#req-github-321-vibe-dashboard-browser-disclosure) and [responsive layout](../../sdd/spec/github.md#req-github-323-responsive-vibe-dashboard-layout). On desktop and tablet, open the drawer and verify GitHub stacks above Storage beside the summary. Close it and verify that, with room to spare, the card is 390 CSS px wide, the full Codeflare label is readable, and GitHub Details sits directly above Storage Usage when present.

With a connected account, verify that clicking `@username` opens the profile in a new tab. For [Vibe repository shortcuts](../../sdd/spec/github.md#req-github-327-vibe-repository-shortcuts), use an authorized fixture with a settled owned-counts response of `{"counts":null}` and at least four loaded, accessible repositories with distinct, known `updated_at` values. Confirm the loading notice is gone and no verified count is shown; a pending request or a verified public-only count does not qualify.

Use an input list not already in newest-first order. For example, load four test repos with `updated_at` values `2025-12-01T00:00:00Z`, `2026-01-01T00:00:00Z`, `2026-03-01T00:00:00Z`, and `2026-02-01T00:00:00Z`, in that order. Verify the card shows exactly the March, February, and January repos in that order, excluding December. Verify the repository icon, repo-name-only links, and age-only controls. Open a repo link and verify the intended GitHub page opens in a new tab without launching a session.

Hover the GitHub card outside the age pills and verify that the card highlights. Move onto an enabled age pill: the pill highlights and the card returns to its normal surface and border. Move back onto the card to verify the card highlight returns. Tab to the pill and verify it has a visible focus outline.

With separate authorization, use a disposable Vibe workspace and a repository with a known default branch and a distinguishable nondefault branch. With no running session, hover an age label for **Clone into a session**, then click it and choose **Open**. While **Restoring repositories…** is still visible for that clone, verify the Chat composer accepts a harmless prompt. If the clone finishes before this can be observed, mark the ordering check unexercised.

For [REQ-GITHUB-330](../../sdd/spec/github.md#req-github-330-workspace-mode-clone-destinations), use a Pi-enabled profile with disposable Pi and non-Pi sessions running. Verify both the Vibe age pill and GitHub Browser Clone offer only eligible running Pi sessions and exactly one new destination, **New Pi session**. Exercise the live and new targets separately. From each Vibe entry point, verify that the new clone opens Chat at `/app/session/<new-session-id>` before any Dashboard action. Then confirm the checkout in each selected session.

In a separate authorized profile or fixture that excludes Pi, verify zero new-session choices at both Vibe entry points. In Code, confirm the browser offers enabled agents.

For [saved Code recovery](../../sdd/spec/github.md#req-github-322-clone-launch-recovery) (AC6), use a Pi-enabled profile and record the failed Code clone’s session identity. Verify Vibe does not offer its retry, then complete a **New Pi session** launch for the same repository. Return to Code and verify **Retry Start** targets the recorded session. Mark this case unexercised if the new Vibe launch does not complete.

The [Layout regression](../../web-ui/src/__tests__/components/Layout.test.tsx) holds Start pending in an automated fixture. Its Back → Forward case checks the clone URL and **Preparing Chat…** after Forward, then releases Start as failed and checks `/app/` after settlement. Cancellation is a separate fixture case.

For [REQ-GITHUB-330 AC4](../../sdd/spec/github.md#req-github-330-workspace-mode-clone-destinations), the automated newer-route case uses `history.pushState` to change the URL without switching away from the active clone. It then releases Start as failed, waits for that clone’s Dashboard card to become visible, and checks that the newer URL remains. No hosted fault fixture is established. Mark hosted failure cases unexercised unless an authorized fixture can preserve the active clone and observe Start settlement without reloading or switching sessions.

Compare the GitHub and Storage card bounds, surface color, border, corner radius, and padding in the same viewport, using Storage Usage as the reference. Repeat the comparison with a successfully loaded empty list and no positive owned count. The black labels then read **NOTHING TO SHOW.** and **GO BUILD SOMETHING.** on two lines.

After restore, check that the clone directory is the Git checkout root, its `origin` matches the selected `owner/repo`, and its checked-out branch matches the known default. A selected repo or a clone request alone does not pass. Record any case without the required fixture or authorization as unexercised.

On mobile, test below 600 CSS px and again from 600 through 640 CSS px. Verify only one browser is visible. Flip in each direction using the keyboard. Verify the incoming face animates, focus moves to its flip control, and Tab cannot enter the inactive face. Escape closes the drawer and returns focus to its grip. Verify the closed browsers cannot receive focus.

Repeat with `prefers-reduced-motion: reduce`: the drawer opens and closes without sliding, and the browsers still swap without flip animation. <!-- @impl: web-ui/src/styles/dashboard.css::.dashboard-panel-body--disclosure -->

With the browsers open and closed, verify Profile stays icon-only and the complete email appears on a black label above the open action panel without widening it. <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard -->

On desktop and tablet, verify the transparent double chevron sits at the summary’s right edge when closed and the browsers’ far right edge when open. It points right when closed and left when open, and bounces slowly sideways. <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @impl: web-ui/src/styles/dashboard.css::.dashboard-panel-pull -->

In both states, verify the transparent hit area is 44 × 150 CSS px and that clicking inside it but outside the icon toggles the drawer. Only the chevron is visible, with no peeking trim. <!-- @impl: web-ui/src/styles/dashboard.css::.dashboard-panel-pull -->

For [mobile Vibe disclosure](../../sdd/spec/github.md#req-github-325-mobile-vibe-browser-disclosure-gestures), verify the white double chevron on a transparent background below the column points down when closed and up when open, with a slow vertical bounce. Tap it in both states. Repeat on all sizes with reduced motion; the bounce stops. <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @impl: web-ui/src/styles/dashboard.css::.dashboard-panel-pull -->

In the installed mobile app, pull up at the bottom to open and down at the top to close. Verify scrolling away from those edges, horizontal swipes, a two-finger pull at an eligible edge, and a closed-panel pull down do not toggle the panel or intercept ordinary refresh.

### GitHub workspace manual acceptance

Reuse the protected Integration viewport checks in [REQ-GITHUB-012](../../sdd/spec/github.md#req-github-012-responsive-github-and-storage-panel-allocation) and the [Integration checklist](deployment.md#integration-acceptance-checklist), with an authorized connected test account. Record browser/device/version and viewport; these are methods, not executed results.

- Select **Code**. At desktop/tablet sizes, confirm the stacked panels stay anchored, repository overflow scrolls and every fetched repository remains reachable.
  - In mobile Code, activate each flip control by keyboard. Confirm focus lands on the incoming panel’s flip control in both directions ([REQ-GITHUB-010](../../sdd/spec/github.md#req-github-010-mobile-github-and-storage-face-switching), AC5). Repeat with reduced motion and confirm an instant swap.
  - With production styles on desktop and tablet, shorten each viewport until the right column is under 600 CSS px. Verify both browsers remain visible without flip controls.
- On a supported touch device, tap the search toggle: observe the actual OS keyboard opening and the input remaining visible above it while typing.
  - Hide search and confirm the filter clears; reopen and verify every repository is reachable by scrolling. DOM focus and mocked scroll calls alone do not establish keyboard or rendered geometry outcomes.

## Backend state and client connectivity

D1 is shared backend authority: `stopped`, `starting`, `running`, `unreachable`, `stopping`, ordered by generation/revision. The DO controls processes; only matching positive exit evidence releases ownership. [Sessions & Runtime](container.md#lifecycle-authority) owns that contract.

Both dashboard and session-dropdown menus expose **Retry Stop** for persisted `stopping`, and **Stop** for starting/running/unreachable sessions. Retry preserves the session and uses the existing authenticated Stop endpoint; the current local Stop suppresses duplicate requests until failure or polling cancellation. After Kill confirms exit, its superseded Stop response cannot block or settle a Stop on the replacement ([REQ-SESSION-041 AC3](../../sdd/spec/session-lifecycle.md#req-session-041-stop-recovery-controls-and-local-attempt-fencing)). Unconfirmed termination stays `stopping`; Start requires authoritative completion. <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> <!-- @impl: web-ui/src/components/SessionDropdown.tsx::SessionDropdown --> <!-- @impl: web-ui/src/stores/session.ts::stopSession --> [REQ-SESSION-006](../../sdd/spec/session-lifecycle.md#req-session-006-user-can-start-stop-restart-and-delete-sessions).

Both menus also offer **Kill** for starting, running, unreachable and stopping sessions, without entering the session. Kill bypasses graceful Stop and final sync; unsynced edits may be lost. See [REQ-SESSION-038](../../sdd/spec/session-lifecycle.md#req-session-038-user-can-force-kill-a-session-container).

Terminal `running` + this device's connected selected socket presents green ACTIVE; no selected socket presents blue IDLE. Classic uses the active outer tab; Herdr uses its single outer terminal `1`. A hidden Classic tab cannot supply the active tab's presence. Neither label is persisted or inferred for another device. <!-- @impl: web-ui/src/components/SessionStatCard.tsx::SessionStatCard --> <!-- @impl: web-ui/src/lib/session-presentation.ts::terminalPresentation -->

Starting/unreachable/stopping use yellow presentation, stopped gray. Countdown expiry cannot establish stopped or dispose workspace state; there is no separate recovery-countdown requirement. <!-- @impl: web-ui/src/lib/session-presentation.ts::terminalPresentation -->

Terminal objects, tabs and tiling remain mounted through transport uncertainty; reattachment deliberately rebuilds buffer/scrollback from the host snapshot rather than retaining prior selection or viewport position. [Terminal restore frame](../../web-ui/src/stores/terminal.ts#L354-L385). Newer authoritative shutdown/deletion evidence owns disposal. [Session polling ownership](../../web-ui/src/stores/session-polling.ts#L266-L335). D1 outage retains the last ordered view, with its status-unavailable notice on the Dashboard rather than an additional active-terminal notice. <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard --> [REQ-TERM-045](../../sdd/spec/terminal.md#req-term-045-local-terminal-presence-presents-active-or-idle) retains its remaining ownership/ordering qualification.

VS Code runs in a separate browser window or tab. Its ready running/unreachable indicator remains green, not Terminal ACTIVE/IDLE; explicit Open focuses the retained live window or opens that session's named target without Start. Codeflare does not add a separate editor-connectivity notice. D1 status outage retains ordered state and shows the Dashboard notice. [REQ-IDE-055](../../sdd/spec/browser-ide.md#req-ide-055-ide-lifecycle-and-connectivity-are-presented-separately) owns ordered status and readiness. [REQ-IDE-063](../../sdd/spec/browser-ide.md#req-ide-063-retained-browser-editor-window-ownership) owns external-window retention, Open and workspace disposal; an allowed disposal transition does not close a browser-owned editor window. <!-- @impl: web-ui/src/lib/browser-ide-window.ts::createBrowserIdeWindowOpener --> <!-- @impl: web-ui/src/components/SessionStatCard.tsx::SessionStatCard --> <!-- @impl: web-ui/src/components/Dashboard.tsx::Dashboard -->

<a id="code-server-browser-ide"></a>
<a id="browser-ide"></a>
<a id="browser-ide-internals"></a>
## Browser IDE workspace behavior

**Canonical behavior anchor: `#browser-ide`.** Browser IDE is the per-session advanced code-server editor, not Cloudflare Browser Run automation. Public routes and client behavior belong here; implementation inventory, adapter composition, private API mechanics and package verification belong exclusively to [`openvscode/README.md`](../../openvscode/README.md). The legacy directory name is intentional, not evidence of an OpenVSCode runtime.

Editor proxy activity is recorded separately from lifecycle. For a session observed running, a proxy response below HTTP 400 schedules a D1 activity update and generation-checked readiness write. That branch includes upgrade responses; its predicate does not establish a healthy editor service. An unreachable session does not use this traffic-triggered update path. <!-- @impl: src/routes/vscode.ts::handleVscodeRequest --> [REQ-IDE-056](../../sdd/spec/browser-ide.md#req-ide-056-editor-readiness-and-activity-merge).

### Workspace launch and availability

The immutable workspace stamp determines dashboard behavior. A VS Code session starts editor after init without host terminal/Herdr prewarm, stays on dashboard, progresses **Preparing**→**Open**, and opens/reuses one editor tab. Changing Default workspace affects future sessions only. Stop/Delete may leave existing editor tab unavailable; dashboard does not close it. Terminal session keeps its terminal and pays no editor process cost until explicit eligible editor request. Header launches the active advanced running session. Non-advanced requests get a clear non-refreshing denial; warming retries are bounded, not an infinite loop. Supervisor lifetime/reaping stays in [Sessions & Runtime](container.md#code-server-browser-ide). [REQ-IDE-003](../../sdd/spec/browser-ide.md#req-ide-003-ide-lifecycle-and-availability), [REQ-IDE-048](../../sdd/spec/browser-ide.md#req-ide-048-default-workspace-and-dashboard-owned-vs-code-sessions).

### Clean session-scoped proxy

Public `/api/vscode/<sessionId>/` stays selector-free. Worker and host independently reject `folder`, `workspace`, `ew`; exact session-prefix ownership prevents another session's path reaching editor. Only private loopback root receives `folder=/home/user/workspace`. Root-relative redirects strip selectors; absolute, scheme-relative and query-relative forms are not rewritten, so universal selector/path removal is not guaranteed. Host projects equivalent fixed `vscode-remote` folder URI with canonical public Host authority, not code-server's deliberate `remote` placeholder. Renderer/extension-host document identity therefore agree. <!-- @impl: host/src/vscode-proxy.ts::projectVscodeWorkbenchWorkspace -->

Root workbench buffering caps 2 MiB and fails closed on missing/duplicate/malformed pinned meta shape or authority, compression or oversize. Assets/protocol stream normally. Native authorized DO `Stub.fetch` transports editor upgrades; HTTP uses existing-port forwarding. Neither starts a replacement runtime. code-server's `--auth none` is confined behind Access/owner chain/container Bearer, on loopback 13337; same-origin framing and proxy authentication remain independent. [REQ-IDE-001](../../sdd/spec/browser-ide.md#req-ide-001-per-session-browser-ide-served-through-the-worker-proxy), [REQ-IDE-012](../../sdd/spec/browser-ide.md#req-ide-012-fixed-clean-browser-ide-workspace-selection), [REQ-IDE-015](../../sdd/spec/browser-ide.md#req-ide-015-clean-browser-ide-url-and-private-workspace-selection), [REQ-IDE-035](../../sdd/spec/browser-ide.md#req-ide-035-canonical-browser-ide-workspace-projection).

### Editor activity transport

Pre-open browser frames retain original order/text/binary form under caps of 128 frames/8 MiB. Flush occurs after upstream open; overflow closes 1013 and cleanup releases listeners/frames on either close/error. Every client-to-server frame refreshes shared host `lastInputAt` without protocol parsing. Server output/socket presence do not become activity. <!-- @impl: host/src/vscode-proxy.ts::bridgeVscodeClientMessages --> [REQ-IDE-004](../../sdd/spec/browser-ide.md#req-ide-004-resilient-editor-activity-transport).

### Selected native IDE agent

Exact tab-1 Pi selects native **Codeflare** Chat/Inline Chat; exact supported Claude selects unchanged official Claude panel; invalid/unsupported selects empty base. Absent configuration preserves legacy Claude. Immutable bases compose with writable user installs; unsupported base stays empty even if user extensions exist. Agent processes/conversations are separate from terminal tab 1 and terminal history/runtime is never projected. No unrelated Accounts/Copilot login is required for Pi inference; compatibility model entries reject generation/authorization. Package-level inventory tables, participant identifiers, FIFO RPC adapters, proposal protocols, validation bounds, dialogs, tool restoration and process error handling are not duplicated here: see [Browser IDE agents](../../openvscode/README.md#selection-and-ui), [Native Pi Chat](../../openvscode/README.md#native-pi-chat), [Official Claude](../../openvscode/README.md#official-claude-code).

Pi panel is unrestricted; native Inline Chat returns validated host-owned edit proposals with controller-owned Keep/Close, not direct panel tool writes or synthetic approval transactions. Each invocation uses bounded canonical-workspace context; cold/replacement panel may hydrate visible history, warm panel/Inline omit replay and Inline does not mutate stored panel history. Native Pi RPC is request-lazy and reused after normal settlement. Reaping is bounded once reached, but cancellation can wait indefinitely on a blocked abort write before that reaper runs. Official Claude uses isolated ephemeral config/unrestricted bypassPermissions and its loopback-authenticated IDE MCP. [REQ-IDE-005/006/007/008/019/020/021/022](../../sdd/spec/browser-ide.md).

### Managed workspace settings and branding

Launch disables telemetry/updates/built-in proxying/Getting Started/workspace trust. Ephemeral User settings are prepared beneath the exact `--user-data-dir`, ignore recommendations and permit user extensions with managed `extensions.allowed` for every inventory. Pi/Claude/unsupported owned keys override restored preferences; preparation failure refuses launch. code-server's supported `--app-name Codeflare` sets title/trust branding; native participant/welcome use packaged product icon, no Code OSS patch. <!-- @impl: entrypoint.sh::_openvscode_prepare_agent --> <!-- @impl: entrypoint.sh::_openvscode_launch_once --> [REQ-IDE-009](../../sdd/spec/browser-ide.md#req-ide-009-frictionless-workspace-open-for-every-ide-agent), [REQ-IDE-039](../../sdd/spec/browser-ide.md#req-ide-039-codeflare-browser-ide-branding), [REQ-IDE-040](../../sdd/spec/browser-ide.md#req-ide-040-user-extension-allowance-policy).

Every inventory exposes **Bash** with `/bin/bash -l`, `MANUAL_TAB=1` to skip existing agent autostart, plus **Codeflare Session Agent** without bypass. Only lowercase auto-detected duplicate bash is suppressed; unrelated detected profiles remain. Terminal workspaces default Bash; VS Code workspaces default Codeflare Session Agent and welcome creates/reuses/focuses that integrated terminal once behind its welcome editor. Thus Bash-first package base and VS Code workspace-specific default are not conflicting promises. [REQ-IDE-047](../../sdd/spec/browser-ide.md#req-ide-047-bash-first-browser-ide-terminals), [REQ-IDE-048](../../sdd/spec/browser-ide.md#req-ide-048-default-workspace-and-dashboard-owned-vs-code-sessions). Package settings mechanics stay in [openvscode README](../../openvscode/README.md#selection-and-ui).

### Bounded IDE continuity

Live editor data/packages/databases/SQLite companions remain ephemeral under `/run/codeflare/openvscode/data`; extensions use its `extensions` child. After generation reap, a maximum-1-MiB atomic fail-closed `~/.codeflare/ide-ui-state.json` exports only theme, string `keyboard.layout`, and schema-valid canonical in-workspace Explorer/open-file resources. Restore prepares fresh workspace storage before inventory-managed settings override keys.

A separate maximum-64-KiB `~/.codeflare/ide-extensions.json` carries at most 50 lowercase ordinary identities/versions, durable warning acknowledgement, and at most 32 KiB of contributed global User settings. Atomic writers emit mode 0600; readers do not require that mode to accept the file. Lazy workbench-after-start restore never gates readiness. Live capture and reap share one manifest path; changed writes wake existing sync. The separate 256 KiB capture handoff stays local. Invalid intent stays unchanged and fixed IDs stay excluded. Uninstall requires matching `.obsolete` evidence; a platform-specific marker cannot remove another platform’s pin. Restore uses two workers and one structured not-found fallback, without retries. <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::restoreExtensionManifest --> <!-- @impl: openvscode/agent-sidebar/src/extension-persistence.ts::captureExtensionManifest --> <!-- @impl: openvscode/extension-persistence-policy.json::captureHandoffMaxBytes --> See [package continuity implementation](../../openvscode/README.md#user-managed-extension-continuity).

No VSIX/extracted bytes, raw database, global/workspace extension state, SecretStorage, Accounts, enablement, keybinding, snippet, authentication, chat history, logs, WAL/SHM enters sync. Private VSIX bytes stay local; capture can still record the registry identity and version. Simultaneous manifests converge whole-file newest-wins. Open VSX over TLS is the supported gallery, not an enforced host gallery allowlist. Code-server disables VSIX signatures and grants proposed APIs broadly. The root-capable-code warning gates manifest-driven installs and the first capture write with extension identities. It does not prevent the native host from activating an already-installed extension. Package pin risk acceptance remains [AD132](../decisions/README.md#ad132-user-extensions-are-a-bounded-manifest-over-an-immutable-base-inventory). [REQ-IDE-002/016/036/037/038](../../sdd/spec/browser-ide.md); storage policy remains in [Storage & Sync](storage-and-sync.md).

Company extension mutation requires both transported verified digests. Missing/mismatched managed manifest preserves current company state and shows remediation; runtime admission belongs to [Sessions & Runtime](container.md#managed-curation-startup-boundary).

### Integration acceptance

After deployment, create fresh Terminal and VS Code sessions. Confirm Terminal uses existing surface without editor until requested; VS Code remains dashboard-owned Preparing→Open, repeated clicks reuse one editor tab, creates one Codeflare Session Agent terminal and no host terminal connection. Change Default workspace and verify existing stamps unchanged. Stop/Delete leaves editor tab unavailable without dashboard closing it. Verify clean selector-free location, same-origin routing, canonical workspace, agent inventory/account-free behavior and isolated conversations. These are acceptance obligations, not evidence obtained by this documentation move.

### Browser IDE native manual acceptance

Use authorized disposable Integration sessions on the selected image. These are verification procedures, not execution results. Session creation, inference, notifications/permissions and fixture writes require their own authorization; this table grants none. Use harmless workspace fixtures, not user content. Compare observable outcomes with the stated criteria and existing constraints.

| Requirement / check | Action | Observable pass/fail |
|---|---|---|
| REQ-IDE-005 AC5 — Account-free Chat | In three fresh Pi sessions, open Codeflare native Chat and complete one authorized harmless request without changing account or model setup. | Each request completes through Codeflare without account setup, authorization or a model-selection prerequisite. Any setup prompt or blocked request fails. |
| REQ-IDE-005 AC6 — Selected inventory | Open three fresh sessions for each configured Pi, Claude and unsupported selection. Inspect the running editor's available agent extensions and surfaces. | Pi exposes Codeflare native Chat, Claude exposes the official Claude extension, and unsupported selection exposes neither. Wrong, absent selected or duplicate agent inventory fails. |
| [REQ-IDE-060](../../sdd/spec/browser-ide.md#req-ide-060-native-editor-context) AC2 — Official Claude context | In three fresh Claude sessions, open a harmless workspace file with a known diagnostic, select a distinctive fragment, ask about that context and request a native diff. Inspect the IDE MCP listener through authorized host access without revealing its token. | Claude receives the active file, selection and diagnostic and presents its native diff. MCP is authenticated and loopback-only. Missing context/diff, unauthenticated access or a public listener fails. |
| REQ-IDE-018 AC1 — Pi notifications | With notification permission separately authorized, complete a Pi response and trigger a native confirmation while the editor is unfocused. Repeat focused and permission-denied cases; activate a delivered notification and observe its lifetime. | Unfocused responses/confirmations follow Code OSS notifications, permission and lifetime policy; focused or denied cases do not bypass that policy. Notification activation focuses the editor. Duplicate terminal-bridge delivery or permission bypass fails. |
| REQ-IDE-018 AC4 — Claude notifications | In an official Claude panel, trigger an authorized action that produces an upstream in-product notification; inspect its presentation and dismissal. | The official panel presents and dismisses its upstream notification normally, with no Codeflare duplicate or unrelated native Chat setup. Missing notification for the triggered event or broken dismissal fails. |
| REQ-IDE-019 AC2 — Inline eligibility | At initial readiness of a fresh Pi editor, open Inline Chat's model picker before submitting any request. | Codeflare is selectable and initially default from its own provider, without Copilot login. A missing model, nondefault selection or login prerequisite fails. |
| REQ-IDE-019 AC3 — Selected-code refactoring | Select harmless fixture code and invoke editor Inline Chat to request a bounded refactor. | Codeflare handles the selected-code request in the editor without Copilot login. Login, panel handoff or no Codeflare dispatch fails. |
| REQ-IDE-019 AC4 — Empty-selection generation | Put the caret in the fixture without selecting text, invoke editor Inline Chat and request a small generation. | Codeflare handles the empty-selection request without Copilot login. A selection prerequisite, login or panel handoff fails. |
| REQ-IDE-019 AC6 — Agent selector | In a fresh Pi editor, open the Code OSS Agent selector and inspect every discovered Codeflare custom agent. | Each Codeflare custom agent appears exactly once. Missing or duplicate entries fail. |
| REQ-IDE-020 AC5 / REQ-IDE-033 AC6 — Native Keep | Record fixture content, generate an Inline proposal and select native Keep in the invoking editor. | Keep accepts the displayed changes, settles the Inline session and leaves controller-owned review state disposed. Missing Keep, different changes or an unsettled session fails. |
| REQ-IDE-020 AC6 / REQ-IDE-033 AC6 — Native rejection and Undo / Native Keep and Close | Record fixture content, generate a proposal and use native Close to reject it. Separately accept another proposal with Keep, then use native Undo. | Close restores the pre-proposal content and disposes the Inline session; Undo restores content through the native edit transaction. Surviving proposal changes or unsettled review state fails. |
| REQ-IDE-033 AC7 — Immediate Inline reentry | Immediately after each Keep and Close outcome, submit a second Inline request in the same document; inspect tabs and editor groups. | Each second request reaches Codeflare without document-URI errors; no duplicate editor tab or group appears. Failure, waiting for a reopen or duplication fails. |
| REQ-IDE-021 AC1/AC4/AC5 — Account-free chrome | Inspect fresh Pi, Claude and unsupported editors, including the activity bar and Chat title bar. In Pi, also inspect available Codeflare models. | Accounts and Chat sign-in controls are hidden in every inventory. Pi hides unrelated built-in AI setup while retaining account-free Codeflare models. Visible unrelated setup/sign-in chrome or lost Codeflare models fails. |
| REQ-IDE-024 AC3 — Welcome presentation | Open the welcome editor in light/dark themes at desktop/mobile widths; enable reduced motion and repeat. Navigate its controls by keyboard. | Text and controls remain legible and reachable without viewport clipping in both themes and widths. Reduced motion suppresses animation/transitions. Unreadable, inaccessible or clipped content, or retained motion, fails. |
| REQ-IDE-027 AC1 — Panel thinking | Run an authorized harmless long panel request with a reasoning-capable provider, observing native thinking, final answer and tool progress. | Provider-authored thinking or summaries stream in native thinking UI separately from the answer. Repeated tool activity stays bounded by category. Missing/sequenced-as-answer thinking or unbounded repeated progress fails; raw hidden chain-of-thought is not requested. |
| REQ-IDE-029 AC1/AC4 — Inline feedback | Submit an edit request and observe progress while Inline Chat is active. Then request an already-satisfied harmless change and inspect the no-change response and document. | At most two immediate progress updates appear. An exposed no-change response renders its bounded summary without edits. The pinned view excludes responses without pending confirmation; details are secondary, not durable. Missing authored summary or unexpected edits fails; exclusion alone is the existing visibility constraint. |

<a id="mobile-terminal"></a>
## Interaction and Focus Model

<a id="multiview-availability"></a>
### MultiView Availability

Phone capacity is zero: shared `getTerminalViewportClass` hides MultiView launch and prevents tiled selection. Tablet capacity is two, desktop two–four. Saved browser membership survives being hidden; tablet/desktop can reopen `MultiView #1` if two eligible terminal members remain. Eligibility includes initializing sessions and mounted starting, running, unreachable or stopping lifecycles; stopped, errored and VS Code sessions are excluded. [REQ-TERM-012](../../sdd/spec/terminal.md#req-term-012-multiview-virtual-session-workspace), [REQ-TERM-013](../../sdd/spec/terminal.md#req-term-013-multiview-selection-flow).

### Cursor Visibility

Native xterm cursor is enabled with initial defaults `cursorBlink: true`, bar, color `#e4e4f0` and accent `#1a2332`. Buffer changes and DECTCEM visibility handlers restore the visible cursor to `#d97706` with the current terminal background as accent. No CSS cursor hiding/alternate-screen blanket hiding; only explicit DECTCEM suppresses it. Supported newer Claude/Copilot use native cursor instead of old duplicate ANSI cursor. Android IME compositor jail is separate and remains. Old orange-square CSS workarounds are historical, not current repair guidance. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> [REQ-MOB-008](../../sdd/spec/terminal.md#req-mob-008-cursor-visible-for-all-supported-agents).

### Keyboard Management

#### VirtualKeyboard API

Enable overlaysContent before terminal focus; disable on actual exit so ordinary inputs resize normally, never during terminal-to-terminal handoff. The VirtualKeyboard `geometrychange` event supplies keyboard height, not polling/timer-based verification ([REQ-MOB-002](../../sdd/spec/terminal.md#req-mob-002-virtual-keyboard-opens-reliably-on-tap) AC3).

#### Multi-pane focus handoff

`vkOpen`, `keyboardHeight`, overlaysContent are one window resource owned by focused terminal. The live `isFocusOnTerminalInput()` query recognizes the active terminal-input iframe, reads current focus rather than a cached value, and is the single discriminator used by every per-pane keyboard-teardown site: hook cleanup, per-input blur and one-tick Samsung focusout. Sibling handoff preserves overlay/signals. Exit/unmount is owner-aware: retiring pane clears only if it owns focus or no terminal remains focused; it cannot clear sibling state. This supersedes older unconditional iframe-removal teardown wording. [REQ-MOB-015](../../sdd/spec/terminal.md#req-mob-015-virtual-keyboard-persists-across-terminal-pane-focus-handoff) AC1. <!-- @impl: web-ui/src/lib/mobile.ts::isFocusOnTerminalInput --> <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::releaseKeyboardOnBlur --> <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::setupMobileInput --> <!-- @test: web-ui/src/__tests__/lib/mobile.test.ts (reports focus resting on a terminal input iframe) -->

Classic retains established mouse/right-click/gesture behavior. Herdr ordinary mouse click/drag/wheel becomes SGR cell input, except browser link activation. Stationary single-finger trusted touchend sends one same-cell press/release, suppresses compatibility mouse, activates MultiView owner then opens mobile input. <!-- @impl: web-ui/src/lib/herdr-mouse.ts::attachHerdrMouseInput --> <!-- @impl: web-ui/src/lib/herdr-mouse.ts::sendHerdrTap --> <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::focusMobileTerminal --> Movement threshold/long press/multi-touch/cancel never activate. Detected links take precedence without SGR/focus. [REQ-MOB-020](../../sdd/spec/terminal.md#req-mob-020-terminal-touch-activation), [REQ-TERM-036](../../sdd/spec/terminal.md#req-term-036-browser-pointer-interaction-with-herdr), [REQ-TERM-017](../../sdd/spec/terminal.md#req-term-017-multiview-pane-focus-and-input-routing).

#### Background prewarm focus safety

Vault on-demand hidden same-origin prewarm is not deferred by terminal keyboard. Valid-token prewarm shell receives focus-inert guards before app scripts: focus/select/window.focus no-op, hidden-document focus blurred; parent restores prior terminal/input if iframe steals it. User-opened Vault is unaffected. [REQ-MOB-014](../../sdd/spec/terminal.md#req-mob-014-mobile-background-surface-focus-isolation), [REQ-VAULT-020](../../sdd/spec/vault.md#req-vault-020-vault-prewarm-focus-safety).

#### Samsung Internet Quirks

Bottom navigation inflates viewport and Samsung exposes no reliable address-bar-position API. User `samsungAddressBarTop` setting supplies that distinction; overlaysContent geometry plus narrow-screen compensation handles bottom position. These are event-driven compatibility patches, not polling/delayed state verification.

#### Stale `geometrychange` Ignore Window

[Samsung geometry filtering](../../sdd/spec/terminal.md#req-mob-024-samsung-stale-keyboard-geometry-filter) ignores cached geometry within 50 ms of an actual overlaysContent toggle. `overlaysContentChangedAt` must not restamp a no-op enable/disable, or the following real event is swallowed and keyboard height remains zero.

<a id="baselineinnerheight--viewportgrowth-compensation"></a>
#### `baselineInnerHeight` / `viewportGrowth` Compensation

Keyboard hides Samsung bottom bar, growing innerHeight without updating CSS viewport. `viewportGrowth=innerHeight-baselineInnerHeight` is subtracted from VK boundingRect height only on narrow bottom-bar layouts.

<a id="baselineinnerheight-immutability"></a>
#### `baselineInnerHeight` Immutability

Page-load baseline stays immutable through keyboard close/reset/stale checks. Only Fold physical screen switch (delta >200 px, keyboard closed) can update it. Samsung emits height-zero before returning navigation bar, so close-time rebasing captures inflated ~47 px and creates persistent gap.

#### Samsung Focusout Handler

Back dismissal may omit geometrychange. Samsung focusout waits one tick; if focus left all terminal input and keyboard was open, force-reset all signals. Sibling handoff does not reset; listener cleanup follows terminal deactivation.

#### Visibility Return Reset

Chrome focus restore force-resets stale signals and enables overlay before focus. Layout fallback force-resets and delays overlay enable 300 ms so Samsung cached events settle. Do not trust resume boundingRect for conditional resets.

Samsung compositor resume instead uses automatic dashboard bounce: reset, deactivate session/dashboard, reactivate after 50 ms cleanup gap, reconnect only visible sockets. Samsung input restore does not auto-focus; delayed overlay enable leaves keyboard closed until user tap. These are compatibility delays, not permission to infer backend stopped. [REQ-MOB-009](../../sdd/spec/terminal.md#req-mob-009-visibility-return-recovers-keyboard-state), [REQ-MOB-011](../../sdd/spec/terminal.md#req-mob-011-samsung-internet-keyboard-state-recovery).

Decorative WebGL canvases retire permanently on coarse-pointer backgrounding or any context loss, stop simulations, leave compositing and reveal dark CSS surface; no restoration request. Landing implementation remains a distinct owner. [REQ-MOB-018](../../sdd/spec/terminal.md#req-mob-018-decorative-webgl-canvas-retirement), [REQ-LANDING-009](../../sdd/spec/landing.md#req-landing-009-decorative-flare-failure-fallback).

#### FitAddon Management

Browser events own keyboard geometry; refitting is not a continuous keyboard-state poll. Initial fitting retries a zero-height container for at most 20 animation frames. Keyboard refit (150-ms debounce), active-state RAF, ResizeObserver RAF and Herdr visibility-return RAF coordinate. A timer ID (`kbDebounceTimer`), not boolean, suppresses competing observer fits and clears safely on cancellation. Every fit requires mounted nonzero-height container; visibility return also requires visible document.

Keyboard refits and activation explicitly own mobile bottom anchoring; terminal output writes have no anchoring callback, and generic scroll correction stays inactive while a touch keyboard is open. Mobile open keyboard intentionally fit/bottom-anchors using buffer-authoritative `scrollBufferToBottom()`. Herdr Pi fullscreen history instead receives trusted End after pane activation and before opening focus; already-open taps preserve viewport. Without keyboard, fit preserves manual reader position and follows bottom only if previously there.

Re-command DOM through `resyncViewportScrollState()` on scroll-owning keyboard/activation/observer/init-overlay/lifecycle refits. Herdr visibility return fits, refreshes full xterm and sends same-size resize repaint. The shared layout refit skips sending a resize when dimensions are unchanged. The terminal's ResizeObserver can still forward the same dimensions through the resize-authority check. Herdr visibility return is a separate intentional same-size repaint. [REQ-MOB-010](../../sdd/spec/terminal.md#req-mob-010-fitaddon-fit-calls-are-coordinated), [REQ-MOB-021](../../sdd/spec/terminal.md#req-mob-021-terminal-follows-visible-container-changes), [REQ-MOB-022](../../sdd/spec/terminal.md#req-mob-022-herdr-mobile-input-focus-and-viewport).

### Touch Input

#### Swipe Gestures

Horizontal arrows repeat every 80 ms while held. touchstart/move/end/cancel all use capture phase so xterm stopPropagation cannot strand repeat. Cleanup always clears timer. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures -->

The xterm Gesture document singleton cancels click synthesis; bubble-phase terminal propagation shield (never preventDefault) isolates terminal touches while capture handlers still run and outside touches stay unchanged. Classic retains browser synthesized click to focus. Herdr uses trusted touchend (prevents default) and direct focus path; compatibility mousedown/up/click are suppressed in bounded post-touch window using touch capability or start/end proximity, while identified hardware mouse passes. Confirmed Herdr scroll blurs stale input focus so Samsung cannot reopen keyboard on release. [REQ-MOB-002](../../sdd/spec/terminal.md#req-mob-002-virtual-keyboard-opens-reliably-on-tap) AC6, [REQ-MOB-020](../../sdd/spec/terminal.md#req-mob-020-terminal-touch-activation), [REQ-MOB-022](../../sdd/spec/terminal.md#req-mob-022-herdr-mobile-input-focus-and-viewport).

Classic converts accumulated swipe distance using `pixelsPerLine = max(12, round(fontSize × lineHeight))`, captured when gestures attach, and emits whole-line steps. Larger line metrics therefore yield fewer steps for the same pixel distance; the single-font fixture does not establish equal cross-font line counts. <!-- @impl: web-ui/src/lib/touch-gestures.ts::attachSwipeGestures -->

Keyboard closed: normal-buffer vertical swipes use BufferService deltas; alternate-screen wheel-capable application owns history, so Classic uses xterm DOM wheel encoding/inertia. Herdr sends proportional wheel steps without inertia and stops at release. Keyboard open: vertical swipes always arrows, even fullscreen mouse tracking; horizontal navigation remains. [REQ-MOB-005](../../sdd/spec/terminal.md#req-mob-005-swipe-gestures-send-arrow-keys-or-scroll), [REQ-MOB-017](../../sdd/spec/terminal.md#req-mob-017-fullscreen-application-touch-scrolling), [REQ-MOB-019](../../sdd/spec/terminal.md#req-mob-019-keyboard-mode-swipe-semantics).

`?debug=1` explicitly enables bounded content-free trace (12 newest records) over keyboard/viewport diagnostics: event order/final cancellation/touch origin/target/focus/moves/geometry, no terminal text/server state. <!-- @impl: web-ui/src/lib/touch-event-debug.ts::attachTouchEventDebug --> <!-- @test: web-ui/src/__tests__/lib/touch-event-debug.test.ts (touch event debug trace) --> [REQ-MOB-023](../../sdd/spec/terminal.md#req-mob-023-opt-in-mobile-input-diagnostics).

#### Input Architecture

- Separate iframe compositor contains Android IME caret. Scoped createElement override during terminal.open uses password input to suppress OS autocorrect, restored afterward. `_syncTextArea` stays active; freezing leaves focus at (0,0) and caused historical top snaps. Live iframe-document focus is not cached.
- Sticky Ctrl is single-use and expires after five seconds without a key press; Ctrl+C/Ctrl+D preserve expected input without intercepting ordinary typing.
- SpeechRecognition is independent of iframe input; supported mobile floating mic or desktop mic/Ctrl+Space captures one utterance (`continuous=false`, `interimResults=false`), then sends final text to terminal.input. Unsupported browser hides controls.
- FloatingTerminalButtons blurs iframe input before microphone permission when its state is `prompt` or unknown, and before clipboard read only when the permission query returns `prompt`. <!-- @impl: web-ui/src/components/FloatingTerminalButtons.tsx::FloatingTerminalButtons -->
  - Unsupported/failed clipboard permission inspection does not trigger that blur. The supplemental `setupMobileInput` clipboard paste path reads directly without this blur; not every paste path dismisses the keyboard. <!-- @impl: web-ui/src/components/FloatingTerminalButtons.tsx::FloatingTerminalButtons --> <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::setupMobileInput -->
- Composition buffers swipe typing until commit. The mobile focus helper and Chrome resume path enable the overlay before focusing; not every direct focus call uses those paths. <!-- @impl: web-ui/src/lib/terminal-mobile-input.ts::setupMobileInput -->
- Floating normal-buffer page controls use buffer-derived page/bottom deltas; alternate-screen controls send PageUp/PageDown to application history, targeting focused MultiView pane even without a single active session.

[REQ-MOB-001/006/007/013/016](../../sdd/spec/terminal.md) retain automated/manual verification qualifiers; device/IME evidence is not inferred from unit tests.

<a id="xterm-61-color-scheme-report-suppression-git-fix-21"></a>
## Terminal Compatibility

The pinned xterm build includes deferred DOM synchronization/full-buffer anchoring, but optional color-scheme reporting is disabled with public typed `vtExtensions: { colorSchemeQuery: false }`. Default-on `CSI ?996n` replies and DECSET 2031 `CSI ?997;1n` theme pushes otherwise flood TUIs that toggle DECTCEM/theme and echo unsupported reports. This restores prior byte behavior; protocol owner is [REQ-TERM-019](../../sdd/spec/terminal.md#req-term-019-terminal-websocket-control-frames-and-protocol-guards) **AC4** (original mobile prose's AC2 reference was stale). <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal -->

Herdr Ctrl+B forwards only canonical prefix and suppresses browser bookmarks; Herdr owns action map (Help prefix+?, Settings prefix+s). Classic/unrelated modified keys stay with xterm, and OS-reserved combinations remain outside browser control. [REQ-TERM-037](../../sdd/spec/terminal.md#req-term-037-browser-keyboard-interaction-with-herdr).

## Scroll Stability

### Root Cause

Historical `_syncTextArea` freeze and capture scroll guard fought browser focus and xterm's JS scroll layer; forcing scrollTop zero could command viewport to absolute top. Both hacks were removed. xterm's deferred sync/native full-buffer anchor remains authoritative; Codeflare never repairs output by distance restoration or generic zero-clamp.

Current ownership ([REQ-TERM-014 AC1–4](../../sdd/spec/terminal.md#req-term-014-terminal-scroll-anchoring-under-scrollback-trimming), [REQ-MOB-004 AC2–5](../../sdd/spec/terminal.md#req-mob-004-scroll-drop-detection-during-burst-output), and [REQ-MOB-012](../../sdd/spec/terminal.md#req-mob-012-scroll-anchoring-during-keyboard-transitions)): <!-- @impl: web-ui/src/hooks/useScrollCorrection.ts::useScrollCorrection --> <!-- @impl: web-ui/src/stores/terminal-output.ts::flushWriteBuffer -->

1. FOLLOW_OUTPUT: synchronous onScroll guard bottom-anchors before paint only while following and no correlated user intent.
2. READ_SCROLLBACK: correlated wheel/pointer/navigation/touch/external intent establishes persistent ownership until live bottom. Output is held, not written beneath reader; oldest whole units drop over cap.
3. MOBILE_INPUT_LOCKED: touch keyboard lifecycle intentionally fits/anchors. Generic correction is inactive, vertical swipes are arrows, fullscreen wheel route only keyboard-closed.

Frontend xterm scrollback is capped at 5,000 lines; the host headless renderer retains 1,000. <!-- @impl: web-ui/src/hooks/useTerminal.ts::useTerminal --> <!-- @impl: host/src/session.ts::Session --> These caps do not establish agent-side virtualization policy: fullscreen Pi/Herdr owns its application history separately, as described below. [REQ-MOB-004 Constraints](../../sdd/spec/terminal.md#req-mob-004-scroll-drop-detection-during-burst-output) retains the separate agent-virtualization claim, whose runtime scope is not proved by these cap values. Pinned JS scroll layer remains sole scroller (`.xterm-viewport` overflow hidden). <!-- @impl: web-ui/src/styles/terminal.css::.xterm .xterm-viewport = overflow: hidden !important --> No fit runs at zero visible height. Writes never reposition; the shared layout refit suppresses unchanged-size frames.

### Persistent Manual Ownership

A short window only correlates first scroll with input intent; touchmove refresh handles long drags. Once correlated ownership has no expiry timer, including legitimate native trim shifts to zero. Returning bottom releases it. Old deep-distance restoration reacted recursively to programmatic events and is not current behavior.

<a id="xterm-61-native-full-buffer-anchoring"></a>
### xterm Native Full-Buffer Anchoring

Native trim keeps surviving content at decremented viewportY, but cannot preserve destroyed viewed lines. Classic normal-buffer hold therefore defers streamed output on the 33-ms schedule under readers, capped 2,000,000 characters, dropping oldest whole atomic units rather than writing through. Bottom return releases whole units toward 65,536 characters per tick, rechecking ownership. The final whole unit may take the tick over that target; an oversized synchronized frame is never split. Classic alternate-buffer output never defers because application owns history. [REQ-TERM-014](../../sdd/spec/terminal.md#req-term-014-terminal-scroll-anchoring-under-scrollback-trimming).

Synchronized DEC 2026 frames remain whole byte-identical units across WS chunks, with bounded stall/size fail-open. No async xterm parser handlers undermine one-write atomicity. Partial assembly never crosses socket boundary; host restore supersedes queued complete units on reconnectable close, final close paints completed units once. [REQ-TERM-021](../../sdd/spec/terminal.md#req-term-021-synchronized-output-frame-atomicity).

### Herdr Viewport Ownership

Fresh Pi starts `--tui-mode fullscreen`; Pi owns history. Codeflare queues/presents complete differential frames in order on the standard 33-ms cadence. The shared output pipeline bypasses read-hold for alternate-buffer application history; normal-buffer scrollback above the live bottom receives the bounded hold regardless of terminal mode. <!-- @impl: image/herdr/codeflare-herdr-terminal::bootstrap --> <!-- @impl: web-ui/src/stores/terminal-output.ts::scheduleWrite --> <!-- @impl: web-ui/src/stores/terminal-output.ts::flushWriteBuffer --> [REQ-TERM-040](../../sdd/spec/terminal.md#req-term-040-stable-herdr-pane-scrollback).

### Viewport DOM Desync (instant yank to top)

Public relative scroll APIs resolve from clamp-prone DOM scrollTop, which can desync during refit/keyboard/pane/address-bar geometry. `scrollBufferLines()` directly commands BufferService with buffer-derived delta and paired repaint; xterm absolute sync then repairs DOM. Normal wheel/touch/page/bottom navigation uses this route; refits retaining readers explicitly resync. Private helper falls back publicly only if internals absent; pin compatibility remains image/test-owned. User input routes reanchor normal-buffer readers, never alternate application history ([AD110](../decisions/README.md#ad110-terminal-scrolling-is-buffer-authoritative-on-every-route-held-output-ring-drops)).

#### Keyboard-Open Suppression

Keyboard lifecycle owns transition fit/bottom, ResizeObserver adds no redundant keyboard-open snap, generic correction stays inactive. Output delegates native shifts, never post-write correction. Keyboard close returns bottom-following and later manual ownership persists until bottom. [REQ-MOB-012](../../sdd/spec/terminal.md#req-mob-012-scroll-anchoring-during-keyboard-transitions).

### Bottom-Following Re-Anchor

Synchronous onScroll compares follower/intent before paint, reentrancy-gates bottom anchoring and yields to readers. Writes only defer/drop/write unchanged; no callback distance restoration, line correction or post-write snap. Integrated native-like feedback tests prove no movement/correction loop ([REQ-TERM-014](../../sdd/spec/terminal.md#req-term-014-terminal-scroll-anchoring-under-scrollback-trimming) AC2/AC3).

### Scroll Stability Overhaul Context

Current mechanisms are synchronous follower guard, persistent correlated manual ownership, external floating-button intent, explicit touch-keyboard ownership and fixed scrollback cap. Earlier competing fix iterations are historical, not additional current mechanisms. Original narrative/history remains in [the immutable mobile guide](https://github.com/nikolanovoselec/codeflare/blob/6c1c11936740aa290266fc98fcbc360d3b5b3af1/documentation/lanes/mobile.md#scroll-stability-overhaul-context).

<a id="websocket-recovery"></a>
## Transport Recovery

Terminal reattachment restores the authoritative host snapshot, rather than preserving the previous client buffer, selection or viewport position. The client resets its buffer/scrollback, applies the serialized host state and returns to the live bottom. Terminal objects, tabs and tiling remain mounted during retry; editor state is unaffected by terminal restore. This is the intended recovery design ([REQ-SESSION-012 AC3](../../sdd/spec/session-lifecycle.md#req-session-012-transport-retry-never-invents-lifecycle-state), [REQ-SESSION-245 AC1–AC2](../../sdd/spec/session-lifecycle.md#req-session-245-transport-recovery-terminal-snapshot-and-editor-state), [REQ-TERM-045 AC5](../../sdd/spec/terminal.md#req-term-045-local-terminal-presence-presents-active-or-idle)). <!-- @impl: web-ui/src/stores/terminal.ts::connect -->

### Retryable Close Codes

Retry 1001/1006/1011/1012/1013 with equal-jitter exponential backoff indefinitely while retryable. A timed-out attempt is retired before its socket closes; delayed events from it cannot change a successor connection or clear its watchdog. Reset on open/visibility return, pause hidden. Normal 1000/unclassified intentional close stays disconnected pending D1 status. 4503 is definitive only when owner-scoped D1 is stopping/stopped and immediately ends retry; network failure/counter/SDK state cannot synthesize it. Failed existing-runtime health/readiness/forward yields retryable 1013 before rate budget, not a replacement start. The original KV-polling wording is obsolete. [REQ-TERM-003](../../sdd/spec/terminal.md#req-term-003-automatic-websocket-reconnection-on-transient-failures), [REQ-TERM-004](../../sdd/spec/terminal.md#req-term-004-close-code-4503-is-authoritative-no-retry), [REQ-TERM-022](../../sdd/spec/terminal.md#req-term-022-an-unreachable-container-ends-the-upgrade-instead-of-escaping-it).

The input handler subscription is owned outside the connect routine and disposed before a replacement handler is attached so reconnect cannot duplicate keystrokes ([REQ-TERM-003](../../sdd/spec/terminal.md#req-term-003-automatic-websocket-reconnection-on-transient-failures) AC4). <!-- @impl: web-ui/src/stores/terminal.ts::terminalStore --> <!-- @test: web-ui/src/__tests__/stores/terminal.test.ts (Terminal Store / REQ-TERM-003 (WS reconnect with exponential backoff (reconnectBackoffMs)) / REQ-TERM-004 (WebSocket lifecycle: connect, attach, detach, close-codes 4503/1013) / REQ-TERM-008 (flushWriteBuffer batches xterm writes for performance)) --> Retries are cancellable. CONNECTING normal teardown lets aborted handlers close on settlement to avoid noisy browser errors; actual stalled handshake times out/force-closes under `WS_CONNECT_TIMEOUT_MS` (`10000` ms). Navigation disconnect grace cancels on quick return. Visibility restore reconnects only visible panes. [REQ-TERM-020](../../sdd/spec/terminal.md#req-term-020-terminal-reconnect-teardown-timeout-and-backoff-timing).

Backend recovery/idle/teardown authority is [Sessions & Runtime](container.md#runtime-recovery-and-status), not client retry timing or browser keyboard recovery.

The host transfers resize authority on detach and preserves successor dimensions; the client clears only its own pending authority. Layout's disconnect grace and visible-return refresh cannot let stale cleanup close a newer connection. Original composition traceability follows these owners: <!-- @impl: host/src/session.ts::detach --> <!-- @impl: host/src/session.ts::resize --> <!-- @impl: web-ui/src/stores/terminal.ts::clearPendingResizeAuthority --> <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> <!-- @impl: web-ui/src/stores/terminal.ts::reconnectDisconnectedTerminals -->

<a id="scroll-stability-integration-test-plan"></a>
## Behavioral Test Matrix

Committed requirement Verification fields in [Terminal](../../sdd/spec/terminal.md) retain original test/manual links. Browser/device checks supply rendering/native event-order evidence where no genuine unit seam exists; this document does not claim those checks were run.

### REQ-MOB-004 test scenarios

1. Stream beyond 5,000 lines: follower remains prompt.
2. Scroll into history, continue output past correlation window: reading position stays still under hold, no trim/drift; bottom return releases bounded units.
3. Return bottom and continue: following resumes.
4. Confirm native viewport overflow remains hidden and sole xterm scroll layer works.

### REQ-MOB-012 test scenarios

1. Tap keyboard-open performs intentional fit/bottom.
2. Keyboard-open output has no generic viewport correction.
3. Close keyboard, then manual reading stays owned until bottom.

### REQ-MOB-019 test scenarios

1. Open-keyboard vertical swipes are arrows, including fullscreen tracking.
2. Closed-keyboard fullscreen swipes use application wheel path.
3. Close keyboard and verify normal scrollback navigation resumes.

### Mobile device acceptance

Phone/tablet command input/output/scrollback; Samsung address-bar top/bottom and back-dismiss; visibility return (Chrome reset/Samsung bounce); Fold screen/orientation changes; sibling MultiView keyboard handoff; first microphone/clipboard permission and IME commit; Herdr single activation/jitter/cancel/scroll/no-keyboard-reopen; open vs closed Pi viewport focus; OSC52 trusted recovery; modified/touch link no terminal side effects; content-free diagnostics; decorative retirement; renderer no zero-height fit.

### Mobile platform checks

These are unexecuted manual checks, not deployment evidence. Use an authorized disposable session and record the release, agent/browser/device versions, viewport and theme. Cover supported phone/tablet configurations, including Android Chrome, Samsung Internet and installed iOS PWA where applicable; an unavailable configuration remains unverified. Use only separately approved command/inference and permission budgets, never personal clipboard content or production changes.

| Check | Action | Observable pass/fail |
|---|---|---|
| Terminal interaction | On desktop, phone and tablet, open the terminal and execute the harmless command `printf 'mobile-ok\n'` through the selected agent's approved execution path. Enter enough harmless output to scroll backward and return to the bottom. | Controls and terminal content fit the viewport; command input, exact output and scrollback remain usable, with only necessary touch differences from desktop. Clipping, lost input/output or inaccessible scrollback fails. |
| Cursor layers | In an authorized disposable Bash session, run the cursor commands below one at a time. Repeat visible/single-cursor observations in each supported agent's fullscreen views; inspect the rendered cursor-layer styles and compare with the palette described above. | One blinking bar remains visible in normal and alternate buffers, with no CSS hiding or duplicated ANSI cursor. Only the explicit hide command suppresses it; the final command restores it. Android's isolated IME caret stays a separate layer. An unavailable agent/view remains unverified. |
| Android IME | Open input, compose a harmless test word using the Android keyboard, then cancel it without submission. Repeat while the viewport changes between keyboard-open and closed. | The native IME caret never escapes the terminal bounds; the compositor remains isolated. Record an out-of-bounds caret as failure, not as the terminal's intended cursor. |
| Herdr focus and history | In Samsung Internet, scroll Pi history upward with the keyboard closed, then tap Pi input. Repeat taps with the keyboard open; scroll history upward again and tap a control. Finally close the keyboard, scroll Herdr and release. | A closed-keyboard tap opens input and reveals the latest output/prompt; an open-keyboard tap activates once without selection and preserves the scrolled viewport. Scrolling with the keyboard closed does not reopen it after release. |
| Tap activation | In Herdr, try a stationary single-finger tap with small jitter, then movement, cancellation, long press and multi-touch against the same control. Repeat an ordinary stationary tap in a separate Classic session. | The Herdr tap activates exactly once; movement, cancellation, long press and multi-touch never activate it. Classic retains its ordinary tap behavior. Duplicate activation fails. |
| Clipboard permission (REQ-MOB-013 AC2, FloatingTerminalButtons) | In a disposable browser profile whose clipboard permission is unset, copy the harmless text `paste-fixture`, open the terminal keyboard and use the floating Paste button. Do not use personal clipboard data. | When permission inspection returns `prompt`, input loses focus and the keyboard no longer obscures a possible permission prompt before clipboard read. Unsupported/failed permission inspection remains unverified for blur-before-prompt; the supplemental `setupMobileInput` paste path does not provide that blur. This unexecuted method is not evidence for every paste path. |
| IME composition | Open an idle terminal prompt and a second authorized view of that same terminal. Swipe-compose a harmless word without committing, then commit it without submitting the prompt; clear the test input afterward. | The second view receives no partial composition as terminal keystrokes; after commit it receives the completed word. Keep any local IME candidate display distinct from remote terminal echo. |
| Input diagnostics | Open the terminal URL with `debug=1`. Tap, move and cancel a touch, then open/close the keyboard. Inspect the overlay; remove the opt-in afterward. | The overlay appears only after opt-in and shows ordering, final cancellation, touch origin/target, focus, move count and viewport/keyboard geometry. It retains at most twelve records and no terminal text. Missing fields or content leakage fails. |
| Decorative context loss | On a fresh page with the decorative canvas active, use browser developer tools to run the snippet below. Repeat on another supported device class when available. | The decorative canvas retires and the app root's dark CSS surface remains visible; terminal interaction still works. A restored animation, blank application surface or lost terminal fails. No available loss extension means unverified, not passed. |

Run these only in the disposable **Bash** terminal, not an agent prompt; they enter the alternate buffer, deliberately hide the cursor, then restore cursor visibility and the original buffer:

```bash
printf '\033[?1049hcursor-fixture\n'
printf '\033[?25l'
printf '\033[?25h\033[?1049l'
```

The decorative-context-loss check uses this browser-console snippet:

```javascript
const canvas = document.querySelector('.splash-cursor-canvas');
const gl = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl');
const loss = gl?.getExtension('WEBGL_lose_context');
if (!loss) throw new Error('Decorative context-loss check unavailable');
loss.loseContext();
```

Retain only nonsecret observations and stop on failed permission or ownership checks. These cases cover the manual portions of [REQ-MOB-001](../../sdd/spec/terminal.md#req-mob-001-terminal-fully-usable-on-mobile-devices), [REQ-MOB-016](../../sdd/spec/terminal.md#req-mob-016-mobile-terminal-input-compositor-and-autocorrect-controls), [REQ-MOB-023](../../sdd/spec/terminal.md#req-mob-023-opt-in-mobile-input-diagnostics), [REQ-MOB-018](../../sdd/spec/terminal.md#req-mob-018-decorative-webgl-canvas-retirement), [REQ-MOB-020](../../sdd/spec/terminal.md#req-mob-020-terminal-touch-activation), [REQ-MOB-022](../../sdd/spec/terminal.md#req-mob-022-herdr-mobile-input-focus-and-viewport) [REQ-MOB-013](../../sdd/spec/terminal.md#req-mob-013-mobile-input-system-platform-compatibility) and [REQ-MOB-008](../../sdd/spec/terminal.md#req-mob-008-cursor-visible-for-all-supported-agents); their automated cases remain separate.

## GitHub workspace acceptance

Use existing disposable targets/content with current protected-access authorization. Mutations require separate approval. Record redacted observations; missing prerequisites remain unverified, not permission to create data or infrastructure.

### GitHub links acceptance

For REQ-GITHUB-002 AC6, use an approved connected account with an existing repository. Activate owner/login and repository-name links by pointer and keyboard. Pass only if each opens the intended GitHub destination in a new tab and repo-name activation creates no clone request, session or workspace folder. Do not press Clone or infer no clone from the new tab alone. Mobile one-face flipping retains its separate Dashboard test and AC5.

### GitHub panel geometry acceptance

For REQ-GITHUB-012 AC1/AC6/AC7, use browser-e2e against protected Integration after access and authentication approval. At desktop and tablet sizes, check both the **Code** split and the open **Vibe** drawer. GitHub stays at the top and Storage at the bottom. The shorter panel takes only the height it needs; the longer panel uses spare height and scrolls internally when needed.

Use existing content where Storage is shorter than unfiltered GitHub but taller than GitHub after a repository search. Apply and clear GitHub search without resizing and verify that the larger allocation swaps between panels. Mark the reversal unverified if suitable content is unavailable; do not upload files or create repositories for the check.

At mobile width in **Code**, switch to each face. Verify short content centers the active face. With an overflowing repository list and an overflowing Storage list, scroll each face to its last item and confirm that the list, not the page, scrolls within the viewport cap. Use existing content and mark unavailable short or overflowing cases unverified. Check that none of these layouts introduces page overflow.

<a id="specification-coverage"></a>
## Requirement and Source Map

| Concern | Requirements | Source | Evidence |
|---|---|---|---|
| Mode/topology/visibility | REQ-TERM-001/007/011/012/013/016/017/018/030/034 | TerminalArea/workspace/tabs/grid | Mode/focus/visible socket behavior |
| Terminal wire/render | REQ-TERM-002/003/004/008/014/019/020/021/022/043/044 | routes/host/terminal store/hooks | Raw/control/retry/restore/atomic output |
| Herdr browser compatibility | REQ-TERM-032/036/037/040/041/042 | mouse/gesture/OSC52/link/output | Pointer/keyboard/clipboard/fullscreen/device |
| Focus/keyboard/fit | REQ-MOB-001/002/003/009/010/011/013/014/015/016/021/022 | mobile/input/hooks/Layout/Vault | Tests plus deployed-device evidence |
| Touch/voice/diagnostics | REQ-MOB-005/006/007/017/019/020/023 | gestures/floating/speech/debug | Mode input and content-free trace |
| Cursor/scroll/decorative | REQ-MOB-004/008/012/018 | xterm/scroll/CSS/SplashCursor | Burst/fit/device/background |
| IDE workspace/proxy | REQ-IDE-001/002/003/004/012/015/035/047/048 | Worker/host/supervisor/UI | Session path/clean workspace/launch |
| IDE integration/continuity | Browser IDE domain | [Package README](../../openvscode/README.md) | Owned package tests/image/deployed acceptance |
| Local presence | REQ-TERM-045, Session Lifecycle | presentation/session store/hooks | Planned ordered cross-device/outage evidence |

## Terminal manual qualification

Record the exact revision/image, approved environment/device and redacted PASS/FAIL/BLOCKED observations. Missing prerequisites block acceptance; source, tests and method links alone never establish a pass.

Protected access, lifecycle/destruction, writes, inference, builds, graph publication and service actions require separate current authorization and existing disposable prerequisites. Do not replay captures/conversations, install harnesses, expose personal data or keys, or change timeouts. These methods grant no such authority.

<a id="req-term-005-manual-qualification"></a>
### Herdr image and additional shells (REQ-TERM-005)


AC1: Inspect the exact image's Container Image workflow steps “Verify packaged Herdr runtime”, “Scan image, generate SBOM, and prepare push tooling”, SBOM upload and provenance attestation. Match the installed version to image/herdr/provenance.json and the runtime digest, executable mode, license, managed config validation and disabled update settings to that image. Require successful scan, SBOM and provenance evidence for the same image, not an older successful run. Missing artifacts block qualification.

AC6: In a fresh configured-agent Herdr session, use Herdr's own tab and pane actions (consult prefix+? Help for the installed bindings); in each new shell run `printf 'shell=%s\n' "$0"`. Pass only when both are plain Bash and neither repeats the configured agent. Preserve the original agent pane; a new agent launch fails.

<a id="req-term-035-manual-qualification"></a>
### Mode-specific prewarm adoption (REQ-TERM-035)


AC1: For fresh Classic and Herdr Terminal sessions, correlate host “Pre-warming tab 1 PTY” identity/PID with the Session adopted when the browser attaches. Pass only when attachment adopts that prewarmed outer Session, not a newly spawned PTY; keep private identifiers out of browser evidence.

AC3: In Classic, correlate first PTY output, “Pre-warm runtime ready, settling” and “Pre-warm ready (settled)” with the first usable browser input/output. Require first-output settlement followed by reachable input. Separately inspect an existing authorized silent-start observation for “Pre-warm ready (timeout)” and subsequent usable input/output. Do not alter startup commands or invent a timeout fixture to manufacture that observation. Without that case the timeout obligation remains unverified.

### Both-mode fixed settlement acceptance

For [REQ-TERM-035 AC7](../../sdd/spec/terminal.md#req-term-035-terminal-readiness-follows-mode-and-workspace), correlate existing authorized Classic and Herdr startup records on the same Integration candidate: first PTY output, runtime-ready/settling and settled timestamps, followed by usable adopted input/output. Herdr's atomic bootstrap precedes settling. Compare logged elapsed values against the fixed 1.5-second interval, allowing displayed rounding and scheduler delay; readiness cannot precede it. Read `host/src/server.ts` to confirm the fixed timer rather than adaptive timing. Timeout records do not qualify normal settlement. Missing timing or either mode is unavailable; do not change commands, insert sleeps or start a session for this inspection.

<a id="req-term-006-manual-qualification"></a>
### Herdr reconnect and shutdown (REQ-TERM-006)


AC4: In a disposable Herdr session, create a tab and split pane and record shell PIDs with harmless `printf 'pid=%s\n' "$$"`. Disconnect the browser without stopping the container, reconnect, and repeat twice. Pass only if topology and the same live processes survive every client exit.

AC5: With separate lifecycle/destruction permission, stop then delete that disposable session, inspecting the named runtime and descendant process state through authorized host access before teardown completes, and termination evidence afterward. Require runtime/descendant termination for both terminal-lifecycle cleanup and container shutdown; inaccessible post-destroy process state without independent exit evidence is blocked, not proof of no orphans. No Kill shortcut or unsynced work.

<a id="req-term-033-manual-qualification"></a>
### Structural replacement without output replay (REQ-TERM-033)


AC3: Record a disposable Herdr session's workspaces/tabs/panes/layout/cwd/focus and any supported native agent session references. Emit a unique harmless pane-output sentinel, then complete normal sync and Stop. Only with replacement authorization, start its replacement from successfully synced state. Compare restored structural state; inspect every restored pane for the sentinel. Pass only when supported structure restores without prior pane output. Running shell/process survival is not promised; do not submit an old conversation or infer successful native resume from structure alone. Unavailable supported-reference evidence stays unverified.

<a id="req-term-008-manual-qualification"></a>
### Batching feedback and disposal (REQ-TERM-008)


AC1/4/5: Inspect `terminal-output.ts::scheduleWrite` and `flushWriteBuffer`: each compound session/terminal key has its own ordered write buffer and arms at most one pending 33-ms timer; arrivals join the buffer without postponing the armed tick. A tick clears its pending timer, writes complete queued units within the existing slice rule when the viewport permits, and rearms only for remaining output/frame assembly or read-hold. Compare the existing terminal-store raw-output and read-hold cases as bounded complementary evidence, not proof of exact scheduling or coalescing on their own; source/test inspection is not an executed timing result.

In a disposable idle Bash terminal, type a harmless unsent token, then clear it. Observe feedback under ordinary and approved harmless streaming output; record perceived lag and any available existing browser performance timestamps as qualitative responsiveness observations. These do not establish a human-perception threshold, a guaranteed end-to-end delay or a measured halving of render passes. Preserve the low-latency intent without inventing a numeric perception bound.

AC6: While harmless output is pending, leave the visible terminal so its client is disposed, then open a different terminal. Require no late paint into the disposed surface, no output crossing into the new terminal, and no disposal error. Preserve the first backend session; client disposal is not Stop. Retain the existing per-terminal cancellation test as complementary evidence, not a substitute for this manual marker.

<a id="req-term-013-manual-qualification"></a>
### MultiView selected-row presentation (REQ-TERM-013)


AC6: On a tablet/desktop with two authorized running sessions, open the session switcher and enter MultiView selection. Toggle one eligible row on then off without launching. Pass only when its selected appearance uses the success visual variant, is distinct from the unselected row, and clears when deselected. Record the visible row states, not merely a DOM attribute. A selected attribute with the wrong visual variant fails.

<a id="req-term-032-manual-qualification"></a>
### Classic OSC52 isolation and permission (REQ-TERM-032)


AC5: In disposable Classic and Herdr Bash sessions with only harmless clipboard fixtures, set the clipboard to `clipboard-before`, then emit `printf '\033]52;c;Y2xpcGJvYXJkLWFmdGVy\007'`. Inspect using the browser's ordinary clipboard paste into a disposable field. Classic must leave `clipboard-before` unchanged and request no Herdr write; Herdr may write `clipboard-after` only as browser permission allows. Repeat with clipboard permission denied: denial must remain authoritative. Never log clipboard content or send a read/query sequence; personal clipboard data is excluded. Restore only the disposable fixture, not private clipboard history.

<a id="req-term-036-manual-qualification"></a>
### Samsung single activation (REQ-TERM-036)


AC6: In Samsung Internet Herdr, tap Pi input and a Herdr control with the keyboard closed, then repeat with it open. Use the existing Mobile platform checks “Tap activation” and “Herdr focus and history” observations; require exactly one addressed activation in all four combinations. Duplicate activation or activation of another pane fails; no inference request is needed merely to tap input.

<a id="req-term-037-manual-qualification"></a>
### Packaged Help and Settings shortcuts (REQ-TERM-037)


AC2/AC4: Inspect the exact image's “Verify packaged Herdr runtime” workflow evidence for pinned-binary `config check` and Help/Settings bindings. In the authorized browser session press Ctrl+B then ?, dismiss Help, then Ctrl+B then s. Pass only when Herdr opens Help and Settings respectively and browser bookmarks do not consume the prefix. Record unsupported OS-reserved combinations as outside browser control, not a promise to override the OS. Classic/unrelated-key handling stays unchanged.

<a id="req-term-040-manual-qualification"></a>
### Samsung fullscreen history during output (REQ-TERM-040)


AC3: On Samsung Internet in a fresh Herdr Pi fullscreen session with separately approved ongoing inference/output, scroll above the live bottom and stop touching the screen while output continues. Pass only if the chosen historical viewport remains stable with no mixed rows and without clicking to repair it; explicitly move the viewport afterward. Do not replace this with a Bash line stream: Pi owns this fullscreen transcript. Without an approved output/inference budget this remains blocked.

<a id="req-mob-009-manual-qualification"></a>
### Chrome visibility-return focus ordering (REQ-MOB-009)


AC1: On Android Chrome, open terminal input, background the browser, then return. With existing browser developer tools observe forceResetKeyboardState, overlay enable and input refocus order in terminal-mobile-input.ts::setupMobileInput; inspect keyboard/viewport state without copying terminal text. Pass only when signals reset and overlay enables before input refocus, with usable input and no stale keyboard gap. Cached geometry alone is not proof. Samsung must instead use its existing dashboard-bounce path; do not conflate the paths.

## Related Documentation

- [Sessions & Runtime](container.md#container-startup)
- [Architecture](architecture.md#frontend-solidjs--xtermjs)
- [API Reference](api-reference.md)
- [Browser IDE package](../../openvscode/README.md)
- [Browser IDE requirements](../../sdd/spec/browser-ide.md)
- [Browser Run requirements](../../sdd/spec/browser-run.md) — separate automation domain
- [Storage & Sync](storage-and-sync.md)
- [Security](security.md)
- [Troubleshooting](troubleshooting.md)

### Repository restore notice

[REQ-GITHUB-320](../../sdd/spec/github.md#req-github-320-nonblocking-terminal-repository-restore-notice) keeps terminal Open independent of cloning. On desktop the restore notice floats bottom-left. On touch tablets and phones it sits just below the open session’s tab bar (or below the header when no tab bar is shown), so users can create and switch tabs during restore. On phones it spans the available width with safe-area clearance. The accent-colored dismiss button is at least 44 × 44 CSS pixels in every layout. It never changes the session-card metrics layout or takes focus.

For an authorized test session with a slow clone, compare Dashboard and terminal views on desktop, tablet and phone, including the on-screen keyboard. Check that Open is usable while the notice says **Restoring repositories…**, the accent-colored close button dismisses any notice, and success also clears automatically. On phone and touch tablet, create and switch tabs while a notice is visible and confirm it does not cover the tab controls. An already-populated workspace needs no startup restore notice. Compare the recorded clone outcome rather than assuming the browser notification proves every repository was restored.

For [REQ-GITHUB-326](../../sdd/spec/github.md#req-github-326-repository-names-in-resume-notices), resume an authorized test session with known restore targets and verify the notice lists their exact `owner/repo` names instead of the session name. In a separate browser fixture, omit only `details.repositoryRestoreRepos` from the Ready response and every subsequent startup-status response for the same generation until you verify that the notice shows the session name and no repository list. Preserve the restore status and generation in each response. <!-- @impl: web-ui/src/components/Layout.tsx::Layout -->

In a constrained mobile viewport, use an active restore notice with 21 repository names. Swipe within the list to reach the last entry while Dismiss stays visible. Repeat from the top using Tab to focus the list and the keyboard to reach the last entry. <!-- @impl: web-ui/src/styles/layout.css::.repository-restore-notice__repos -->

Missing restore details or missing/older generations consume the retry budget. A matching confirmed stop or error, a newer generation, lost local restore ownership, or exhausted observation budget ends tracking. A disappearing notice does not establish success. <!-- @impl: web-ui/src/stores/session.ts::watchRepositoryRestore -->

Cloning from the Dashboard into a running session uses this same notification surface. It shows **Cloning repository…** with the repository and session names, then reports the outcome. **Repository cloned; automatic restore not confirmed** means the checkout exists in the running session but the restore inventory was not confirmed. <!-- @impl: web-ui/src/components/Layout.tsx::Layout --> Success clears after five seconds; other outcomes stay dismissible. Selecting a running-session target closes the picker immediately after the shared notice starts; progress and results no longer require a Done step. Dismissal or a newer clone prevents late responses from restoring an older notice; different sessions remain independent. This path does not start or select a session or change terminal readiness.
