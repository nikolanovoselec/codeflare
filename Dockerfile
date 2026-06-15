# Codeflare Container - Multi-session terminal server with rclone sync
# Uses node-pty for PTY management and rclone for R2 storage sync

# ---- Stage 1: Builder (compile native addons + TypeScript) ----
# Use AWS ECR Public mirror of Docker Hub to avoid anonymous pull rate limits on CI.
# Shared GitHub Actions runner IPs routinely hit Docker Hub's 100-pull/6h cap.
FROM public.ecr.aws/docker/library/node:24-bookworm-slim@sha256:242549cd46785b480c832479a730f4f2a20865d61ea2e404fdb2a5c3d3b73ecf AS builder

RUN apt-get update && apt-get install -y --no-install-recommends make gcc g++ python3 && rm -rf /var/lib/apt/lists/*

COPY host/package.json host/package-lock.json /app/host/
WORKDIR /app/host
# Install all deps (including devDependencies for TypeScript compilation)
RUN npm ci
# Copy TypeScript source and config, then compile
COPY host/tsconfig.json /app/host/
COPY host/src/ /app/host/src/
RUN npm run build
# Remove devDependencies after build to keep runtime image lean
RUN npm prune --omit=dev

# ---- Stage 2: Runtime ----
FROM public.ecr.aws/docker/library/node:24-bookworm-slim@sha256:242549cd46785b480c832479a730f4f2a20865d61ea2e404fdb2a5c3d3b73ecf

# Suppress npm update nag; configure Claude Code for non-interactive container use
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
ENV IS_SANDBOX=1
ENV DISABLE_INSTALLATION_CHECKS=1
ENV DISABLE_AUTOUPDATER=1
ENV NODE_COMPILE_CACHE=/root/.cache/node-compile-cache

# Upgrade base packages + install runtime packages (single apt-get update layer)
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    # System essentials
    ca-certificates \
    bash \
    # ECC continuous learning v2.1 observe hooks
    python3 \
    # graphify (uv tool install) needs venv module for isolated tool envs
    python3-venv \
    # Version control
    git \
    # Editors
    nano \
    neovim \
    ncurses-bin \
    ncurses-base \
    ncurses-term \
    # Network tools
    curl \
    openssh-client \
    # Process utilities
    procps \
    # Utilities
    jq \
    ripgrep \
    fd-find \
    tree \
    htop \
    tmux \
    fzf \
    # Yazi preview dependencies
    file \
    p7zip-full \
    bat \
    unzip \
    # Sandbox for OpenAI Codex
    bubblewrap \
    # GPG for GitHub CLI repo key
    gpg \
    && rm -rf /var/lib/apt/lists/* \
    # Symlinks for Debian-renamed binaries
    && ln -s "$(which fdfind)" /usr/local/bin/fd \
    && ln -s "$(which batcat)" /usr/local/bin/bat \
    # Symlink vim → neovim so both `vim` and `nvim` commands work
    && ln -s "$(which nvim)" /usr/local/bin/vim \
    # Remove yarn shipped by Node base image (unused, 5MB)
    && rm -rf /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg

# Install rclone (pinned version — unpinned install.sh broke bisync, see documentation/storage-and-sync.md)
RUN curl -fsSL https://downloads.rclone.org/v1.73.5/rclone-v1.73.5-linux-amd64.deb -o /tmp/rclone.deb \
    && echo "c4de165467dd9066a72931ea2bee616e43eccf36f6f1c06a34757d0f6f25c7f1  /tmp/rclone.deb" | sha256sum -c - \
    && dpkg -i /tmp/rclone.deb \
    && rm /tmp/rclone.deb

# Add GitHub CLI apt repo (key + source list only — actual install is after .cache-bust)
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /tmp/githubcli-archive-keyring.gpg \
    && echo "6084d5d7bd8e288441e0e94fc6275570895da18e6751f70f057485dc2d1a811b  /tmp/githubcli-archive-keyring.gpg" | sha256sum -c - \
    && mv /tmp/githubcli-archive-keyring.gpg /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list

# Install zoxide from GitHub releases (pinned version, not in Debian bookworm repos)
RUN ZOXIDE_VERSION="0.9.9" && \
    ZOXIDE_SHA256="4ff057d3c4d957946937274c2b8be7af2a9bbae7f90a1b5e9baaa7cb65a20caa" && \
    curl -fsSL --retry 3 --retry-delay 5 --connect-timeout 30 "https://github.com/ajeetdsouza/zoxide/releases/download/v${ZOXIDE_VERSION}/zoxide-${ZOXIDE_VERSION}-x86_64-unknown-linux-musl.tar.gz" -o /tmp/zoxide.tar.gz && \
    echo "${ZOXIDE_SHA256}  /tmp/zoxide.tar.gz" | sha256sum -c - && \
    tar xzf /tmp/zoxide.tar.gz -C /usr/local/bin zoxide && \
    chmod +x /usr/local/bin/zoxide && \
    rm /tmp/zoxide.tar.gz

# Install yazi and lazygit from GitHub releases (pinned versions)
RUN YAZI_VERSION="26.5.6" && \
    YAZI_SHA256="1031a02560d053301537195a6661d227c15cb4ce5c30481050b31e2b88681bff" && \
    curl -fsSL --retry 3 --retry-delay 5 --connect-timeout 30 "https://github.com/sxyazi/yazi/releases/download/v${YAZI_VERSION}/yazi-x86_64-unknown-linux-musl.zip" -o /tmp/yazi.zip && \
    echo "${YAZI_SHA256}  /tmp/yazi.zip" | sha256sum -c - && \
    unzip -o /tmp/yazi.zip -d /tmp/yazi && \
    mv /tmp/yazi/yazi-x86_64-unknown-linux-musl/yazi /usr/local/bin/yazi && \
    chmod +x /usr/local/bin/yazi && \
    rm -rf /tmp/yazi /tmp/yazi.zip
RUN LAZYGIT_VERSION="0.62.2" && \
    LAZYGIT_SHA256="8b9a4c2d0969cbea92b45c956dd2a44e1ba76900c9df49f1c60984045ce77984" && \
    curl -fsSL --retry 3 --retry-delay 5 --connect-timeout 30 "https://github.com/jesseduffield/lazygit/releases/download/v${LAZYGIT_VERSION}/lazygit_${LAZYGIT_VERSION}_linux_x86_64.tar.gz" -o /tmp/lazygit.tar.gz && \
    echo "${LAZYGIT_SHA256}  /tmp/lazygit.tar.gz" | sha256sum -c - && \
    tar xzf /tmp/lazygit.tar.gz -C /usr/local/bin lazygit && \
    chmod +x /usr/local/bin/lazygit && \
    rm /tmp/lazygit.tar.gz

# Install SilverBullet server (Deno-compiled single binary). Used by the
# codeflare-vault plugin as the in-browser markdown editor for the persistent
# vault at /home/user/Vault. Bound to localhost:3030 by the
# supervisor loop in entrypoint.sh; reached from the codeflare UI through the
# Worker proxy at /api/vault/:sid/.
#
# SilverBullet 2.x ships TWO binaries per release: `sb-...` (CLI client) and
# `silverbullet-server-...` (the actual server). We want the server.
RUN SILVERBULLET_VERSION="2.9.0" && \
    SILVERBULLET_SHA256="fe2b27651d11833727cd1b989a666d1000bd16e805130c6c461cda4c6dc1c69d" && \
    curl -fsSL --retry 3 --retry-delay 5 --connect-timeout 30 "https://github.com/silverbulletmd/silverbullet/releases/download/${SILVERBULLET_VERSION}/silverbullet-server-linux-x86_64.zip" -o /tmp/silverbullet.zip && \
    echo "${SILVERBULLET_SHA256}  /tmp/silverbullet.zip" | sha256sum -c - && \
    unzip -o /tmp/silverbullet.zip -d /tmp/silverbullet && \
    mv /tmp/silverbullet/silverbullet /usr/local/bin/silverbullet && \
    chmod +x /usr/local/bin/silverbullet && \
    rm -rf /tmp/silverbullet /tmp/silverbullet.zip

# Install Claude Code globally (official @anthropic-ai/claude-code).
# IS_SANDBOX=1 allows --dangerously-skip-permissions when running as root.
# .cache-bust is generated by deploy workflow with unique SHA per build.
# COPY invalidates this layer so npm resolves fresh "latest" each deploy.
COPY .cache-bust /tmp/.cache-bust

# Preseed SilverBullet config + (best-effort) Atlas plug. entrypoint.sh copies
# these into /home/user/Vault/.silverbullet/ on first session boot.
# Atlas plug is optional; vault visualisation falls back to graphify-out/graph.html
# if atlas.plug.js is not present.
COPY preseed/silverbullet/ /opt/silverbullet-preseed/

# Install gh CLI (after .cache-bust so every deploy gets latest)
RUN apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g @anthropic-ai/claude-code@latest && \
    rm -f /tmp/.cache-bust && \
    npm cache clean --force && \
    rm -rf /root/.npm

# Verify Claude Code is installed and working as root with IS_SANDBOX=1
RUN claude --version

# Install Codex + OpenCode + Copilot + Pi CLIs for multi-agent support (single RUN for npm dedup).
# OpenCode (opencode-ai) is an open-source multi-model AI coding CLI supporting 75+ providers.
# Consolidated install allows npm to deduplicate shared dependencies across packages.
# OpenCode ships 11 platform binaries as optionalDependencies — delete unused ones (~446MB saved).
# Debian uses glibc — postinstall correctly hard-links opencode-linux-x64 to bin/.opencode.
# Uses @latest — .cache-bust above invalidates this layer so every deploy pulls
# newest versions (user policy: all coding agents auto-update at deploy). The
# jiti warm-up layer below stays correct under @latest because it runs with the
# pi just installed here — the baked cache is always generated by the same
# pi/jiti that will consume it at runtime.
RUN npm install -g @openai/codex@latest opencode-ai@latest @github/copilot@latest @earendil-works/pi-coding-agent@latest && \
    cd /usr/local/lib/node_modules/opencode-ai/node_modules && \
    find . -maxdepth 1 -name 'opencode-*' ! -name 'opencode-linux-x64' -type d -exec rm -rf {} + && \
    cd /usr/local/lib/node_modules/@github/copilot && \
    find prebuilds/ -maxdepth 1 -type d ! -name 'prebuilds' ! -name 'linux-x64' -exec rm -rf {} + && \
    rm -rf mxc-bin/arm64 ripgrep/ clipboard/node_modules pvrecorder/node_modules sharp/node_modules && \
    npm cache clean --force && \
    rm -rf /tmp/* /root/.npm

# Antigravity (Go-native binary, curl installer, not npm). Fatal on failure (no fallback).
RUN curl -fsSL https://antigravity.google/cli/install.sh | bash

# Ensure the Antigravity binary (agy) is on PATH at /usr/local/bin.
RUN AGY_BIN=$(command -v agy || find / -name 'agy' -type f -perm -u+x 2>/dev/null | grep -v '/proc/' | head -1) && \
    if [ -z "$AGY_BIN" ]; then echo "ERROR: agy binary not found after antigravity install" >&2; exit 1; fi && \
    if [ "$AGY_BIN" != "/usr/local/bin/agy" ]; then ln -sf "$AGY_BIN" /usr/local/bin/agy; fi && \
    agy --version && \
    rm -rf /tmp/*

# Preinstall Pi extension npm dependencies into an image-local seed cache.
# ~/.pi/agent/npm/node_modules is excluded from R2 sync, so without this Pi
# would run a slow npm install on first launch (~90s on mobile). Entrypoint
# symlinks node_modules to this cache (instant, zero-copy).
COPY preseed/agents/pi/package.json preseed/agents/pi/package-lock.json /opt/codeflare/pi-agent/npm/
# Local Pi extensions, used by the jiti warm-up layer below (they reach user
# containers via the R2 agent seed, verbatim — same content, so the
# content-addressed cache entries baked from these files hit at runtime).
COPY preseed/agents/pi/extensions/ /opt/codeflare/pi-agent/extensions/
# better-sqlite3 / bufferutil / utf-8-validate are native (node-gyp) modules. Their
# prebuilt-binary fetch is best-effort and falls back to a source compile, which needs
# make + a C/C++ toolchain. stage-1 ships python3 but not make/gcc/g++ (those live only
# in the discarded builder), so a prebuilt-fetch miss fails with "not found: make".
# Install the toolchain just for this npm ci and purge it in the same layer (mirroring
# the graphify-build pattern below) so the runtime image stays lean.
RUN cd /opt/codeflare/pi-agent/npm && \
    apt-get update && \
    apt-get install -y --no-install-recommends make gcc g++ && \
    npm ci --omit=dev --no-audit --no-fund && \
    apt-get purge -y make gcc g++ && \
    apt-get autoremove -y && \
    npm cache clean --force && \
    rm -rf /root/.npm /var/lib/apt/lists/*

# Install Bun for faster context-mode ctx_execute / ctx_batch_execute subprocess
# starts. Bun is faster than Node for short-lived JS subprocess starts; the
# improvement adds up across an interactive session that fires hooks on every
# Bash/Read/WebFetch/Grep/Glob/Agent tool call. No spec contract on the perf
# delta - if a Bun release regresses, the runtime falls back to Node and
# nothing breaks (perf-only optimization).
#
# Bun is autodetected by context-mode at first invocation; no entrypoint
# wiring needed. The Bun binary is a single self-contained executable
# (~50MB on disk) installed by `npm install -g bun`.
#
# Note: Bun is NOT a fix for the dynamic-require bug in #309 - that bug
# reproduces under both Node and Bun ESM loaders. The shim patch in the
# context-mode block below is the durable fix; Bun is purely a perf win.
# Pinned (unlike the @latest tools above): context-mode autodetects Bun at
# runtime and substitutes it for Node in the JS/TS subprocess path, so a
# breaking Bun release silently regresses ctx_execute for every user. Bump
# this version deliberately after smoke-testing a new release.
RUN npm install -g bun@1.3.14 && \
    bun --version && \
    # Strip 258MB of non-linux platform binaries shipped in bun's npm package.
    # Only the linux-x64 binary (bun.exe / bunx.exe hardlinked in bin/) is needed.
    rm -rf /usr/local/lib/node_modules/bun/node_modules && \
    npm cache clean --force && rm -rf /root/.npm

# Install context-mode globally and patch the esbuild ESM bundles.
# Implements REQ-AGENT-005. See codeflare#309 for the bug report.
#
# context-mode ships an esbuild ESM bundle (cli.bundle.mjs +
# server.bundle.mjs) whose CJS-require shim throws on every dynamic
# require('node:*') call because esbuild does not inject a
# createRequire polyfill in --format=esm output. The shim's
# `typeof require < "u"` check evaluates to "undefined" in BOTH Node
# and Bun ESM modules, so ctx_execute / ctx_batch_execute fail with
# `Dynamic require of "node:fs" is not supported` regardless of which
# runtime invokes the bundle. The verified-working fix (issue #309)
# is a 2-line createRequire shim prepended to both bundles after
# extraction.
#
# We do that here at build time so the patched bundles ship in the
# container image with no runtime extraction, no per-session bunx
# download, and no first-call delay. Hooks and the MCP server invoke
# `context-mode` directly from /usr/local/bin (the global install).
#
# License posture (ELv2): we do NOT redistribute context-mode source.
# npm pulls the package from the public registry at build time
# exactly as `npx -y context-mode` would at runtime.
COPY preseed/agents/claude/plugins/context-mode/.claude-plugin/plugin.json /tmp/context-mode-plugin.json
RUN <<'EOF'
set -e
VER=$(jq -r '.version // empty' /tmp/context-mode-plugin.json)
if [ -z "$VER" ]; then
  echo "[Dockerfile] FATAL: plugin.json has no .version field; build cannot proceed" >&2
  exit 1
fi
echo "[Dockerfile] installing context-mode@$VER"
npm install -g "context-mode@$VER"
CTX_DIR="$(npm root -g)/context-mode"
export CTX_DIR
node <<'NODE'
const fs = require('fs');
const path = require('path');
const dir = process.env.CTX_DIR;
const shimMarker = '__ctx_createRequire';
const shim = "import { createRequire as __ctx_createRequire } from 'node:module';\nvar require = __ctx_createRequire(import.meta.url);\n";
for (const name of ['cli.bundle.mjs', 'server.bundle.mjs']) {
  const f = path.join(dir, name);
  if (!fs.existsSync(f)) {
    console.error('[Dockerfile] FATAL: ' + f + ' not found; context-mode layout may have changed');
    process.exit(1);
  }
  let c = fs.readFileSync(f, 'utf8');
  if (c.includes(shimMarker)) {
    console.log('[Dockerfile] ' + name + ' already patched, skipping');
  } else {
    if (c.startsWith('#!')) {
      const nl = c.indexOf('\n');
      c = c.slice(0, nl + 1) + shim + c.slice(nl + 1);
    } else {
      c = shim + c;
    }
    fs.writeFileSync(f, c);
    console.log('[Dockerfile] patched ' + name);
  }
  // Postcondition check: re-read and verify the shim is present at
  // the expected position. Catches regressions if a future esbuild
  // bundle ships with a coincidental marker collision or if the
  // write silently truncated.
  const verify = fs.readFileSync(f, 'utf8');
  const head = verify.startsWith('#!') ? verify.slice(verify.indexOf('\n') + 1) : verify;
  if (!head.startsWith("import { createRequire as __ctx_createRequire } from 'node:module';")) {
    console.error('[Dockerfile] FATAL: post-write verification failed for ' + name + '; first non-shebang bytes: ' + JSON.stringify(head.slice(0, 80)));
    process.exit(1);
  }
}
NODE
# Smoke-test BOTH bundles so a regression in server.bundle.mjs surfaces
# at build time. cli.bundle.mjs is exercised by `--version`.
context-mode --version
node -e "import('/usr/local/lib/node_modules/context-mode/server.bundle.mjs').catch(e => { console.error('[Dockerfile] FATAL: server.bundle.mjs import failed:', e.message); process.exit(1); }).then(() => console.log('[Dockerfile] server.bundle.mjs imports cleanly'))"
rm -f /tmp/context-mode-plugin.json
npm cache clean --force
rm -rf /root/.npm
EOF

# ---------------------------------------------------------------------------
# Pre-warm the consult-llm-mcp MCP server (used by Claude Code + Pi via the
# consult-llm MCP config in entrypoint.sh). Installing it globally at build time
# means the runtime MCP command invokes the global bin from /usr/local/bin with
# no per-session `npx -y` registry fetch / first-call delay (same pattern as the
# context-mode + agent-CLI globals). Pinned (not @latest) and shadow-tracked by
# the `consult-llm-mcp` job in .github/workflows/bump-shadow-pins.yml, since a
# Dockerfile `npm install -g` literal is invisible to Dependabot. In Enterprise
# Mode the MCP config is not written (consult-llm is disabled), so this baked
# binary is simply unused there — harmless.
RUN npm install -g consult-llm-mcp@2.13.4 && \
    command -v consult-llm-mcp >/dev/null || { echo "[Dockerfile] FATAL: consult-llm-mcp not on PATH after install" >&2; exit 1; } && \
    npm cache clean --force && \
    rm -rf /root/.npm

# ---------------------------------------------------------------------------
# Claude-side Browser Run MCP server (REQ-BROWSER-005). The analog of Pi's
# native browser-run.ts extension: exposes the Cloudflare Browser Run REST Quick
# Actions (markdown / content / scrape) as MCP tools so Claude has the same cheap
# one-shot page-read surface Pi has. chrome-devtools-mcp gives Claude the
# interactive surface; this gives it the clean HTML->Markdown / scrape surface.
# Registered in ~/.claude.json by entrypoint.sh under the same advanced + CF-token
# gate. The @modelcontextprotocol/sdk version in package.json is pinned (exact)
# and shadow-pinned (the `browser-run-mcp` job in bump-shadow-pins.yml bumps it
# weekly; no lockfile, invisible to Dependabot). Built here so the runtime invokes
# `node /opt/codeflare/browser-run-mcp/index.mjs` with no per-session npm fetch.
COPY preseed/agents/claude/browser-run-mcp/ /opt/codeflare/browser-run-mcp/
RUN cd /opt/codeflare/browser-run-mcp && \
    npm install --omit=dev --no-audit --no-fund && \
    node -e "import('/opt/codeflare/browser-run-mcp/index.mjs').then(() => console.log('[Dockerfile] browser-run-mcp imports cleanly')).catch(e => { console.error('[Dockerfile] FATAL: browser-run-mcp import failed:', e.message); process.exit(1); })" && \
    npm cache clean --force && \
    rm -rf /root/.npm

# ---------------------------------------------------------------------------
# Install graphify (Python knowledge-graph tool) globally via uv.
# Implements REQ-AGENT-023.
#
# Version is read from preseed/agents/claude/plugins/graphify/.claude-plugin/
# plugin.json so a Dependabot bump to that file rebuilds the image with the
# new graphify version in lockstep (same pattern as context-mode above).
#
# Extras: [mcp,sql,pdf]
#   - mcp: the MCP stdio server (python -m graphify.serve)
#   - sql: tree-sitter-sql for SQL schema extraction
#   - pdf: pypdf + markdownify for PDF docs
# Omitted: provider/backend extras such as [gemini], plus [office] [google]
# [video] [neo4j] [ollama] [bedrock]. Interactive semantic extraction and
# community labels are produced by the active agent session, not Graphify
# provider backends.
#
# Layer cost: ~220MB (Python + 30 tree-sitter wheels). One-time at build, not
# per-session. The `graphify` shim lands at /root/.local/bin/graphify and the
# isolated venv lives at /root/.local/share/uv/tools/graphifyy/.
#
# License posture (Apache-2.0): we install from the public PyPI registry at
# build time. No redistribution. Friendlier license than context-mode's ELv2.
# ---------------------------------------------------------------------------
COPY preseed/agents/claude/plugins/graphify/.claude-plugin/plugin.json /tmp/graphify-plugin.json
RUN <<'EOF'
set -e
# Install uv (Astral's Python package manager - recommended by graphify upstream).
# UV_INSTALL_DIR pins the install location so it's predictable for PATH/ENV.
export UV_INSTALL_DIR=/root/.local/bin
curl -fsSL https://astral.sh/uv/install.sh | sh
export PATH="/root/.local/bin:$PATH"

VER=$(jq -r '.version // empty' /tmp/graphify-plugin.json)
if [ -z "$VER" ]; then
  echo "[Dockerfile] FATAL: graphify plugin.json has no .version field; build cannot proceed" >&2
  exit 1
fi
echo "[Dockerfile] installing graphifyy==$VER with [mcp,sql,pdf] extras"
# graphifyy 0.8.25+ pulls tree-sitter-dm, an sdist-only grammar (no manylinux
# wheel), which uv compiles from source. tree-sitter-dm builds a CPython
# extension module, so it needs both a C compiler AND the Python dev headers
# (Python.h). This final runtime stage has neither (gcc lives only in the
# discarded `builder` stage, and the base ships python3 runtime without -dev),
# so install gcc/g++/python3-dev just for this build and purge them in the same
# layer: the runtime image stays lean and free of an extra toolchain attack
# surface. Without this the build fails with "Python.h: No such file or
# directory" (and, before that, "x86_64-linux-gnu-gcc: No such file or directory").
apt-get update
apt-get install -y --no-install-recommends gcc g++ python3-dev
uv tool install "graphifyy[mcp,sql,pdf]==$VER"
apt-get purge -y gcc g++ python3-dev
apt-get autoremove -y
rm -rf /var/lib/apt/lists/*

# Expose the graphify CLI on the system PATH so non-interactive bash
# subshells (hook scripts, memory-capture sonnet, vault-extract sonnet,
# graphify-active-repo.sh) can resolve `command -v graphify`. uv installs
# the shim at /root/.local/bin/graphify but that directory is not on the
# default container PATH (/usr/local/bin:/usr/bin:/bin:...), so scripts
# that gate on `command -v graphify` silently noop without this symlink.
# Verified failure: graphify-active-repo.sh never seeds ~/.graphify/global-graph.json
# in production prior to this fix.
ln -sf /root/.local/share/uv/tools/graphifyy/bin/graphify /usr/local/bin/graphify

# Smoke-test: ensure the CLI works and the MCP server module imports cleanly.
# A regression in either (e.g. missing tree-sitter wheel, broken entry-point)
# surfaces at build time rather than at first user invocation.
graphify --version
uv tool run --from graphifyy python3 -c "import graphify.serve" \
  || (echo "[Dockerfile] FATAL: graphify.serve import failed" >&2 && exit 1)

rm -f /tmp/graphify-plugin.json

# Register the graphify semantic merge driver globally (REQ-AGENT-023).
# When a repo's .gitattributes contains `graphify-out/graph.json merge=graphify`,
# git hands conflicting graph.json files to this driver for semantic merge
# instead of line-based merge (which would produce corrupt JSON). The driver
# is part of the graphifyy install above; this just wires it into git config
# globally so every repo in every session benefits with no per-clone setup.
#
# Tier independence is intentional: this lands in /etc/gitconfig (root user
# global) regardless of session mode (default or advanced). Matches the
# pattern that the graphify CLI + MCP server are also ambient capability
# across modes per AD52 - only the discipline (hooks + rule + skill) is
# advanced-gated. A default-mode session that never sees the graphify plugin
# manifest still has a functional merge driver pointing at a real binary.
git config --global merge.graphify.driver "graphify merge-driver %O %A %B"
git config --global merge.graphify.name "graphify semantic graph.json merge"
EOF

# Make uv-installed shims available to all users (entrypoint runs as root)
ENV PATH="/root/.local/bin:${PATH}"

# V8 compile cache warm-up: Pre-populate Node.js V8 compile cache at Docker build time.
# Running --version triggers V8 to compile and cache bytecode for each CLI's JavaScript.
# This speeds up first-launch of Node.js CLIs (codex, copilot, pi) inside containers
# by avoiding the compilation overhead on every container start.
# Note: Go binaries (like opencode and antigravity) don't need this — they're already natively compiled.
RUN codex --version 2>&1 || true && \
    copilot --version 2>&1 || true && \
    pi --version 2>&1 || true

# Pi extension warm-up: pre-transpile the full Pi extension set (npm packages +
# local preseed extensions) into a baked jiti cache + the V8 compile cache.
# `pi --version` above does NOT load extensions; without this layer every fresh
# container paid ~9s of cold jiti transpile before Pi's first PTY output,
# pushing the host's pre-warm past its 20s hard cap (session startup 15s ->
# 30-35s after the 6-package preseed bundle shipped). Mechanics, all validated
# against the live container:
# - jiti caches transpiles under $TMPDIR/jiti (its path-valued JITI_FS_CACHE
#   env is ignored by this build), so the warm run redirects TMPDIR and the
#   result is moved to /opt/codeflare/jiti-cache; the entrypoint symlinks
#   /tmp/jiti -> there at boot (same pattern as the npm preseed symlink).
# - The cache is content-addressed (source hash), so entries baked here hit at
#   runtime even though the seeded extensions land at a different path with
#   fresh mtimes (the R2 agent seed ships them verbatim).
# - The throwaway agent dir mirrors the runtime layout (npm symlinked to the
#   image preseed cache, exactly like the entrypoint does); the package list is
#   DERIVED from the preseed package.json so a version bump there warms the
#   right set automatically.
# - The pi run exits non-zero on the missing-LLM-key model call AFTER
#   extensions load (|| true); the mv + final test fail the build if the cache
#   came out empty, so a pi CLI change that breaks the warm-up is caught at
#   build, not as a silent startup regression in production.
RUN mkdir -p /opt/codeflare/jiti-warm-tmp /tmp/pi-warm/agent && \
    ln -s /opt/codeflare/pi-agent/npm /tmp/pi-warm/agent/npm && \
    cp -r /opt/codeflare/pi-agent/extensions /tmp/pi-warm/agent/extensions && \
    node -e 'const d=require("/opt/codeflare/pi-agent/npm/package.json").dependencies;process.stdout.write(JSON.stringify({packages:Object.entries(d).map(([n,v])=>`npm:${n}@${v}`)}))' > /tmp/pi-warm/agent/settings.json && \
    (TMPDIR=/opt/codeflare/jiti-warm-tmp PI_CODING_AGENT_DIR=/tmp/pi-warm/agent PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 timeout 240 pi -p "warm" || true) && \
    mv /opt/codeflare/jiti-warm-tmp/jiti /opt/codeflare/jiti-cache && \
    rm -rf /opt/codeflare/jiti-warm-tmp /tmp/pi-warm && \
    test -n "$(ls -A /opt/codeflare/jiti-cache)"

# Pre-initialize OpenCode's SQLite database to skip Goose migrations on first launch.
# OpenCode stores its DB at ~/.local/share/opencode/opencode.db (XDG data dir) and runs
# schema migrations on every startup. Running `opencode run` at build time triggers the
# migration ("Performing one time database migration") so first interactive launch is fast.
# Unset all provider keys so the migration runs without making an actual LLM call.
# GitHub Actions injects GITHUB_TOKEN which OpenCode would use for GitHub Models.
RUN ANTHROPIC_API_KEY="" OPENAI_API_KEY="" GEMINI_API_KEY="" GITHUB_TOKEN="" \
    timeout 30 opencode run "hello" 2>&1 || true

# Verify critical tools are installed (including vim→nvim symlink)
RUN git --version && gh --version && rclone --version && node --version && \
    vim --version && \
    which yazi && which lazygit

# Browser shims: force CLI tools to fall back to displaying auth URLs as text.
# Claude Code checks BROWSER env var; OpenCode/Bun use xdg-open directly.
# When these shims exit 1, the CLIs print the URL as plain text in the PTY,
# where the xterm.js link provider detects and makes it clickable.
# (OSC 8 hyperlinks don't work here because CLIs spawn BROWSER/xdg-open as a
# child process and capture stdout -- the output never reaches the PTY.)
RUN printf '#!/bin/bash\nexit 1\n' > /usr/local/bin/open-url && \
    chmod +x /usr/local/bin/open-url && \
    printf '#!/bin/bash\nexit 1\n' > /usr/local/bin/xdg-open-shim && \
    chmod +x /usr/local/bin/xdg-open-shim && \
    ln -sf /usr/local/bin/xdg-open-shim /usr/bin/xdg-open
ENV BROWSER=/usr/local/bin/open-url

# Create workspace directory structure
RUN mkdir -p /app/host

# Copy pre-compiled host server from builder stage
COPY --from=builder /app/host/node_modules /app/host/node_modules
COPY --from=builder /app/host/dist /app/host/dist
COPY host/package.json /app/host/

# Copy entrypoint script
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh && echo "Build timestamp $(date)" > /build-timestamp.txt

# Reset working directory
WORKDIR /

# Expose port 8080: Terminal server (handles WebSocket + health/metrics)
EXPOSE 8080

# Graceful shutdown
STOPSIGNAL SIGINT

# Run as root by design. SAST-false-positive: rclone FUSE mount, runtime tool
# installation (npm install -g, agent CLIs), and user workspace access all
# require root throughout the container lifetime, not just during init. The
# security boundary is network isolation via the Durable Object proxy: only
# the DO can reach port 8080, and the per-DO container auth token validates
# every proxied request.
ENTRYPOINT ["/entrypoint.sh"]
