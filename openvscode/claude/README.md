# Official Claude Code IDE configuration

**Audience:** Browser IDE contributors

**Owns:** the Claude allowlisted configuration projection and Codeflare-managed settings around Anthropic's unmodified package.

**Does not own:** package selection/pinning, inventory classification, code-server lifecycle, public routing, or complete-image verification. Those belong to the [parent package reference](../README.md) and canonical Container lane.

## File map

| File area | Responsibility |
|---|---|
| `prepare-sidebar-config.mjs` | Build and validate the temporary allowlisted Claude projection before code-server starts |
| Managed settings source | Apply Codeflare-owned package settings without modifying Anthropic's package |
| `test/*.test.mjs` | Verify projection allowlist, settings, failure behavior, and restart semantics through the parent Vitest suite |

## Projection contract

Before the Claude inventory starts, the preparer creates `/tmp/codeflare-sidebar/claude/config` with mode `0700`. It links only approved credentials/configuration entries when present: `.credentials.json`, `CLAUDE.md`, `agents`, `commands`, `plugins`, and `skills`. The root-owned managed `settings.json` is supplied separately.

Terminal projects, history, session state, logs, caches, telemetry, source settings, and unknown entries are never projected. The schema marker contains its version plus link and managed-settings metadata, never credential bytes. A valid existing temporary projection may survive a code-server restart within the same IDE/container lifecycle; it is not durable session storage.

Projection preparation is an availability and containment gate: code-server does not launch the Claude inventory when validation fails.

## Managed settings

Managed settings select Anthropic's graphical panel in the right sidebar, point the bundled CLI at the isolated config directory, start in the owner-approved unrestricted `bypassPermissions` mode, permit dangerous permission skipping, suppress an unnecessary Anthropic login prompt, and disable unrelated native Chat/Copilot setup. The generic Accounts control is hidden while VS Code authentication APIs remain available.

Remote Control, IDE auto-install, extension updates, and nonessential telemetry remain disabled because they are unrelated to the package's Codeflare role. Codeflare adds no credential request/export bridge, command classifier, approval hook, or sandbox around Claude tools.

Anthropic's official extension owns its loopback-authenticated IDE MCP transport, context, native diffs, panel state, and tool behavior. Codeflare neither patches that package nor exposes its transport publicly.

## Develop and verify

The Claude projection tests run from the parent package:

```sh
cd openvscode/agent-sidebar
npm install
npm test
```

Use `npm run typecheck` and `npm run build` when parent extension/package composition changes. Complete-image package identity, immutability, and process-laziness checks remain in GitHub Actions.

## Canonical references

- [Browser IDE package reference](../README.md)
- [Container — code-server Browser IDE](../../documentation/lanes/container.md#code-server-browser-ide)
- [Security — Browser IDE native agents](../../documentation/lanes/security.md#browser-ide-native-agents)
- [Browser IDE requirements](../../sdd/spec/browser-ide.md)
