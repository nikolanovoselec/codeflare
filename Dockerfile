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

# ---- Codeflare native Pi Chat extension builder (OpenVSCode Node 22) ----
FROM public.ecr.aws/docker/library/node:22.21.1-bookworm-slim@sha256:25b3eb23a00590b7499f2a2ce939322727fcce1b15fdd69754fcd09536a3ae2c AS openvscode-agent-sidebar-builder

WORKDIR /app/openvscode/agent-sidebar
COPY openvscode/agent-sidebar/package.json openvscode/agent-sidebar/package-lock.json ./
RUN npm ci
COPY openvscode/agent-sidebar/tsconfig.json openvscode/agent-sidebar/esbuild.mjs openvscode/agent-sidebar/official-claude.json ./
COPY openvscode/agent-sidebar/src/ ./src/
RUN npm run typecheck && NODE_ENV=production npm run build

RUN mkdir -p /out/extension && \
    cp package.json /out/extension/package.json && \
    cp -a dist /out/extension/dist
COPY openvscode/agent-sidebar/media/ /out/extension/media/

# ---- Official Claude Code Open VSX extension ----
# Owner-accepted license risk: install Anthropic's exact unmodified linux-x64
# package into the image, configured externally at runtime. Never serve the VSIX.
FROM public.ecr.aws/docker/library/node:22.21.1-bookworm-slim@sha256:25b3eb23a00590b7499f2a2ce939322727fcce1b15fdd69754fcd09536a3ae2c AS openvscode-official-claude-extension

COPY openvscode/agent-sidebar/official-claude.json /tmp/official-claude.json
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip && rm -rf /var/lib/apt/lists/*
RUN CLAUDE_VSCODE_NAMESPACE="$(node -p 'require("/tmp/official-claude.json").namespace')" && \
    CLAUDE_VSCODE_NAME="$(node -p 'require("/tmp/official-claude.json").name')" && \
    CLAUDE_VSCODE_VERSION="$(node -p 'require("/tmp/official-claude.json").version')" && \
    CLAUDE_VSCODE_PLATFORM="$(node -p 'require("/tmp/official-claude.json").targetPlatform')" && \
    CLAUDE_VSCODE_SHA256="$(node -p 'require("/tmp/official-claude.json").sha256')" && \
    export CLAUDE_VSCODE_VERSION && \
    curl -fsSL --retry 3 --retry-delay 5 --connect-timeout 30 --max-time 600 \
      "https://open-vsx.org/api/${CLAUDE_VSCODE_NAMESPACE}/${CLAUDE_VSCODE_NAME}/${CLAUDE_VSCODE_PLATFORM}/${CLAUDE_VSCODE_VERSION}/file/${CLAUDE_VSCODE_NAMESPACE}.${CLAUDE_VSCODE_NAME}-${CLAUDE_VSCODE_VERSION}@${CLAUDE_VSCODE_PLATFORM}.vsix" \
      -o /tmp/anthropic.claude-code.vsix && \
    echo "${CLAUDE_VSCODE_SHA256}  /tmp/anthropic.claude-code.vsix" | sha256sum -c - && \
    mkdir -p /tmp/anthropic-claude && \
    unzip -q /tmp/anthropic.claude-code.vsix 'extension/*' -d /tmp/anthropic-claude && \
    mv /tmp/anthropic-claude/extension /out && \
    node -e 'const pin=require("/tmp/official-claude.json"),p=require("/out/package.json"); if(p.name!==pin.name||p.publisher!==pin.namespace||p.version!==pin.version||p.main!==pin.main||p.engines?.vscode!==pin.vscodeEngine) process.exit(1)' && \
    test -x /out/resources/native-binary/claude && \
    test -z "$(find /out -type l -print -quit)" && \
    test -z "$(find /out -iname '*.vsix' -print -quit)" && \
    DISABLE_AUTOUPDATER=1 CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
      /out/resources/native-binary/claude --version | grep -F "${CLAUDE_VSCODE_VERSION}" && \
    rm -rf /tmp/anthropic.claude-code.vsix /tmp/anthropic-claude

# ---- Assemble immutable agent inventories once, before the runtime image ----
FROM public.ecr.aws/docker/library/node:22.21.1-bookworm-slim@sha256:25b3eb23a00590b7499f2a2ce939322727fcce1b15fdd69754fcd09536a3ae2c AS openvscode-agent-inventories

COPY --from=openvscode-agent-sidebar-builder /out/extension /tmp/codeflare-sidebar-extension
COPY --from=openvscode-official-claude-extension /out /tmp/official-claude-extension
RUN /usr/local/bin/node --input-type=module -e \
      'const { stageSidebarExtension } = await import("file:///tmp/codeflare-sidebar-extension/dist/package-extension.mjs"); await stageSidebarExtension({ sourceDirectory: "/tmp/codeflare-sidebar-extension", claudeSourceDirectory: "/tmp/official-claude-extension", rootDirectory: "/out/openvscode" });' && \
    rm -rf /tmp/codeflare-sidebar-extension /tmp/official-claude-extension && \
    test -f /out/openvscode/extensions/pi/codeflare-agent-sidebar/dist/extension.cjs && \
    test -f /out/openvscode/extensions/claude/anthropic.claude-code/extension.js && \
    test -x /out/openvscode/extensions/claude/anthropic.claude-code/resources/native-binary/claude && \
    test -z "$(find /out/openvscode/extensions/none -mindepth 1 -print -quit)" && \
    test -z "$(find /out/openvscode -iname '*.vsix' -print -quit)"

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
    # ECC continuous learning v2.1 observe hooks and common `python` CLI alias
    python3 \
    python-is-python3 \
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
RUN ZOXIDE_VERSION="0.10.0" && \
    ZOXIDE_SHA256="2d93385b99f3e82cf2701609a1bffcad863fbeb75aa3fe7eb6be4d29be68b1ae" && \
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
RUN LAZYGIT_VERSION="0.63.1" && \
    LAZYGIT_SHA256="8e033bc78c8e192dee9510e951f6c9e154289b7198d22c924ed1d0a951b0dac1" && \
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

# Install coder/code-server as the Browser IDE runtime. It runs per session
# behind the authenticated /api/vscode/:sid/ proxy, lazy-started on loopback by
# entrypoint.sh (REQ-IDE-001, AD119). The retained `openvscode` source and
# inventory names below are private migration identifiers, not runtime binaries.
#
# The release archive, code-server commit, embedded Code package version, and
# immutable upstream VS Code gitlink are all pinned. The artifact embeds the
# code-server commit in package.json and product.json; the build verifies both
# plus the real lib/vscode package version. Shadow Pins derives the gitlink from
# the immutable release tag and owns every literal in this block.
RUN CODE_SERVER_VERSION="4.130.0" && \
    CODE_SERVER_SHA256="3de23052e34fa705b3817efa66201cbc8d8ba6615b4cd03120c39bfc0ae1b7ab" && \
    CODE_SERVER_COMMIT="197ef3e8da8ee99ed6ca8f1a630157527e6d448f" && \
    CODE_SERVER_CODE_VERSION="1.130.0" && \
    CODE_SERVER_VSCODE_COMMIT="1b6a188127eeaf9194f945eb6eb89a657e93c54c" && \
    curl -fsSL --retry 3 --retry-delay 5 --connect-timeout 30 --max-time 600 \
      "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-linux-amd64.tar.gz" \
      -o /tmp/code-server.tar.gz && \
    echo "${CODE_SERVER_SHA256}  /tmp/code-server.tar.gz" | sha256sum -c - && \
    mkdir -p /opt/code-server && \
    tar -xzf /tmp/code-server.tar.gz -C /opt/code-server --strip-components=1 && \
    ln -sf /opt/code-server/bin/code-server /usr/local/bin/code-server && \
    test -x /opt/code-server/bin/code-server && \
    test "$(jq -r .version /opt/code-server/package.json)" = "$CODE_SERVER_VERSION" && \
    test "$(jq -r .commit /opt/code-server/package.json)" = "$CODE_SERVER_COMMIT" && \
    test "$(jq -r .version /opt/code-server/lib/vscode/package.json)" = "$CODE_SERVER_CODE_VERSION" && \
    test "$(jq -r .codeServerVersion /opt/code-server/lib/vscode/product.json)" = "$CODE_SERVER_VERSION" && \
    test "$(jq -r .commit /opt/code-server/lib/vscode/product.json)" = "$CODE_SERVER_COMMIT" && \
    jq -n \
      --arg codeServerVersion "$CODE_SERVER_VERSION" \
      --arg codeServerCommit "$CODE_SERVER_COMMIT" \
      --arg codeVersion "$CODE_SERVER_CODE_VERSION" \
      --arg vscodeCommit "$CODE_SERVER_VSCODE_COMMIT" \
      '{codeServerVersion:$codeServerVersion,codeServerCommit:$codeServerCommit,codeVersion:$codeVersion,vscodeCommit:$vscodeCommit}' \
      > /opt/code-server/codeflare-provenance.json && \
    test -d /opt/code-server/lib/vscode/extensions/copilot && \
    rm -rf /opt/code-server/lib/vscode/extensions/copilot && \
    test ! -e /opt/code-server/lib/vscode/extensions/copilot && \
    /usr/local/bin/code-server --version && \
    test ! -e /usr/local/bin/openvscode-server && \
    test ! -e /opt/openvscode-server && \
    rm -f /tmp/code-server.tar.gz

# Fixed immutable inventories: Codeflare's native Pi participant, Anthropic's
# exact official Claude extension, and an empty unsupported-agent inventory.
# The assembled tree is copied once, so the 285 MiB official package is not
# duplicated through a runtime staging layer.
COPY --from=openvscode-agent-inventories /out/openvscode /opt/codeflare/openvscode

# Official Claude sessions use an isolated config projection. Managed settings
# and hooks remain root-owned; terminal history and runtime state are never
# copied into the projection.
COPY openvscode/claude/managed-settings.mjs \
     openvscode/claude/prepare-sidebar-config.mjs \
     openvscode/claude/prepare-sidebar-config.sh \
     openvscode/claude/sidebar-settings.json \
     /opt/codeflare/openvscode/claude/
RUN mkdir -p /etc/codeflare/claude-sidebar && \
    cp /opt/codeflare/openvscode/claude/sidebar-settings.json /etc/codeflare/claude-sidebar/settings.json && \
    chmod 0555 /opt/codeflare/openvscode/claude/prepare-sidebar-config.sh && \
    find /opt/codeflare/openvscode/claude -type f ! -name prepare-sidebar-config.sh -exec chmod 0444 {} + && \
    chmod 0555 /opt/codeflare/openvscode/claude /etc/codeflare/claude-sidebar && \
    chmod 0444 /etc/codeflare/claude-sidebar/settings.json && \
    cmp /opt/codeflare/openvscode/claude/sidebar-settings.json /etc/codeflare/claude-sidebar/settings.json

COPY scripts/ci/smoke-openvscode-sidebar-image.mjs /opt/codeflare/openvscode/smoke-openvscode-sidebar-image.mjs
COPY scripts/browser-ide-ui-state.py /opt/codeflare/openvscode/browser-ide-ui-state.py
RUN chmod 0444 /opt/codeflare/openvscode/smoke-openvscode-sidebar-image.mjs && \
    chmod 0555 /opt/codeflare/openvscode/browser-ide-ui-state.py

# REQ-STOR-017 / AD90: bake the agent-config seed tree into the image so a Governed Mode
# (R2 SSE-C disabled) container can lay it down locally BEFORE the initial R2 sync — the
# `--checksum` sync then skips the unchanged seed files and transfers only user deltas.
# Derived in-image from the COMMITTED, freshness-enforced src/lib/agent-seed.generated.ts
# (single source of truth), so this needs no host build ordering and never drifts. Placed
# above the .cache-bust COPY so the layer caches on the seed content, not every deploy.
COPY src/lib/agent-seed.generated.ts /opt/codeflare/seed-src/agent-seed.generated.ts
COPY scripts/materialize-agent-seed.mjs /opt/codeflare/seed-src/materialize-agent-seed.mjs
RUN node /opt/codeflare/seed-src/materialize-agent-seed.mjs \
        --seed /opt/codeflare/seed-src/agent-seed.generated.ts \
        --out /opt/codeflare/agent-seed-bake \
    && echo "[Dockerfile] agent-seed bake materialized for default + advanced modes"

# Install Claude Code globally (official @anthropic-ai/claude-code).
# IS_SANDBOX=1 allows --dangerously-skip-permissions when running as root.
# .cache-bust is generated by the deploy workflow with a unique SHA per build.
# COPY invalidates this layer, so every deploy re-runs the installs below rather
# than reusing a cached layer. It no longer re-resolves "latest": the agent CLI
# versions are ARG-pinned and moved by the agent-clis bump job. Anything that
# reasons "nothing below needs per-deploy resolution, so the installs can move
# above this COPY" must account for the jiti/prewarm layers further down, which
# depend on the pi installed here.
COPY .cache-bust /tmp/.cache-bust

# Preseed SilverBullet config + (best-effort) Atlas plug. entrypoint.sh copies
# these into /home/user/Vault/.silverbullet/ on first session boot.
# Atlas plug is optional; vault visualisation falls back to graphify-out/graph.html
# if atlas.plug.js is not present.
COPY preseed/silverbullet/ /opt/silverbullet-preseed/

# Install gh CLI (after .cache-bust so every deploy re-resolves the apt version)
RUN apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Pinned, not @latest. Every OS binary in this file is sha256-pinned and
# dependabot.yml spends 40 lines justifying a 7-day cooldown against the
# publish-malicious-then-wait pattern — yet the agent CLIs, the most privileged
# packages in the image (they execute user code and hold OAuth tokens), were the
# ones exempt from all of it, and the ISO-week salt guaranteed a rebuild picked
# up a bad version within 7 days. Trivy detects CVEs, not malicious publishes.
# Still auto-updates weekly, but through a reviewable bump PR: see the
# `agent-clis` job in .github/workflows/bump-shadow-pins.yml.
ARG CLAUDE_CODE_VERSION=2.1.219
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" && \
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
# Pinned rather than @latest, for the reason given above the claude-code install.
# The agents still auto-update weekly — the `agent-clis` bump job moves these
# ARGs — but through a PR that CI has run against, instead of resolving whatever
# the registry served at build time. The jiti warm-up layer below stays correct
# because it runs with the pi installed here, so the baked cache is always
# generated by the same pi/jiti that consumes it at runtime.
ARG CODEX_VERSION=0.145.0
ARG OPENCODE_VERSION=1.18.4
ARG COPILOT_VERSION=1.0.74
ARG PI_CODING_AGENT_VERSION=0.82.0
RUN npm install -g \
      "@openai/codex@${CODEX_VERSION}" \
      "opencode-ai@${OPENCODE_VERSION}" \
      "@github/copilot@${COPILOT_VERSION}" \
      "@earendil-works/pi-coding-agent@${PI_CODING_AGENT_VERSION}" && \
    cd /usr/local/lib/node_modules/opencode-ai/node_modules && \
    find . -maxdepth 1 -name 'opencode-*' ! -name 'opencode-linux-x64' -type d -exec rm -rf {} + && \
    cd /usr/local/lib/node_modules/@github/copilot && \
    if [ -d prebuilds ]; then find prebuilds/ -maxdepth 1 -type d ! -name 'prebuilds' ! -name 'linux-x64' -exec rm -rf {} +; fi && \
    rm -rf mxc-bin/arm64 ripgrep/ clipboard/node_modules pvrecorder/node_modules sharp/node_modules && \
    npm cache clean --force && \
    rm -rf /tmp/* /root/.npm

# Assert the pin took, and that the pruning above did not break what it pruned.
#
# What this DOES check: that `npm install -g "pkg@${ARG}"` actually installed the
# pinned version. With an empty ARG that spec resolves to latest, silently
# unpinning the most privileged packages in the image — so comparing the
# installed version against the ARG is what makes the pin load-bearing rather
# than decorative. The Pi prewarm block below already asserts exactly this; these
# four were the exception.
#
# What it does NOT check, stated plainly: `command -v` is a symlink-existence
# test. It cannot tell that the blind prune below matched nothing (`if [ -d
# prebuilds ]` yields 0 when absent, `rm -rf` yields 0 on missing paths), nor
# that a release relocated a native binary, nor that something copilot now needs
# was removed. Actually invoking the three binaries would close that, but the
# --version warm-ups were deliberately removed (AD96) because their V8 compile
# caches inflate the image; re-adding them here would undo that trade. The gap is
# real and unclosed.
RUN set -eu; \
    check() { \
      installed=$(node -p "require('/usr/local/lib/node_modules/$1/package.json').version" 2>/dev/null || true); \
      if [ "$installed" != "$2" ]; then \
        echo "ERROR: $1 installed as '${installed:-<missing>}' but the pin says '$2'" >&2; exit 1; \
      fi; \
      echo "  $1 == $2"; \
    }; \
    check "@anthropic-ai/claude-code" "${CLAUDE_CODE_VERSION}"; \
    check "@openai/codex" "${CODEX_VERSION}"; \
    check "opencode-ai" "${OPENCODE_VERSION}"; \
    check "@github/copilot" "${COPILOT_VERSION}"; \
    check "@earendil-works/pi-coding-agent" "${PI_CODING_AGENT_VERSION}"; \
    for b in codex opencode copilot; do \
      command -v "$b" >/dev/null || { echo "ERROR: $b is not on PATH after install+prune" >&2; exit 1; }; \
    done; \
    echo "agent CLIs: pins verified, binaries present"

# Antigravity (Go-native binary, curl installer, not npm). Fatal on failure (no fallback).
#
# The installer itself is pinned by sha256; previously this was a bare
# `curl … | bash`, so whatever that URL served at build time ran as root with no
# integrity check at all. The PAYLOAD is already covered — the script fetches a
# manifest carrying a sha512 and aborts on mismatch ("Security Halt") — but the
# manifest is served by the same host, so that is self-certifying. Pinning the
# script is what stops arbitrary substitution; tracked by the `antigravity-cli`
# job in bump-shadow-pins.yml so it still updates, visibly.
#
# BREAK-GLASS: this URL is unversioned, so the moment Google edits the script
# every image build fails here — including an emergency hotfix — until the hash
# is updated. That is the point of a pin, but the recovery path must not be
# discovered mid-incident: read the new script, then set this ARG to its sha256
# (`curl -fsSL <url> | sha256sum`). Do NOT work around it by dropping the check.
ARG ANTIGRAVITY_INSTALLER_SHA256=ee1ea43ce4e9e56356c4ab6dad907ef357ae4bdfcaadb682735909fb57c9c640
RUN curl -fsSL https://antigravity.google/cli/install.sh -o /tmp/agy-install.sh && \
    echo "${ANTIGRAVITY_INSTALLER_SHA256}  /tmp/agy-install.sh" | sha256sum -c - && \
    bash /tmp/agy-install.sh && \
    rm -f /tmp/agy-install.sh

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
COPY preseed/agents/pi/npm/ /opt/codeflare/pi-agent/npm/
# Local Pi extensions, used by the jiti warm-up layer below (they reach user
# containers via the R2 agent seed, verbatim — same content, so the
# content-addressed cache entries baked from these files hit at runtime).
COPY preseed/agents/pi/extensions/ /opt/codeflare/pi-agent/extensions/
# better-sqlite3 / bufferutil / utf-8-validate are native (node-gyp) modules. Their
# prebuilt-binary fetch is best-effort and falls back to a source compile, which needs
# make + a C/C++ toolchain. stage-1 ships python3 but not make/gcc/g++ (those live only
# in the discarded builder), so a prebuilt-fetch miss fails with "not found: make".
# Install the toolchain just for this install and purge it in the same layer (mirroring
# the graphify-build pattern below) so the runtime image stays lean.
#
# Version bridge — keep the prewarm Pi SDK in lockstep with the runtime agent.
# @earendil-works/pi-coding-agent is only a TRANSITIVE dep of the extensions here, so
# a frozen lockfile would pin it independently from the global agent above — they
# drift, and Trivy eventually flags the stale prewarm copy. (The global is now
# ARG-pinned too, but the bridge still reads the INSTALLED version rather than the
# ARG, so it stays correct if the two ever diverge.)
# (CVE-2026-54328 was the first). Read the EXACT version the global install
# just resolved, force it across the whole prewarm tree via an npm override, drop the
# stale lock and reinstall. This layer sits below the .cache-bust COPY, so it re-runs
# every deploy and the prewarm SDK is ALWAYS identical to the runtime agent. The build
# fails closed: an empty PI_VER (global path/layout changed) aborts before reinstall, and
# a post-install assertion confirms the override actually pinned the transitive copy — so a
# future Pi packaging change can never silently ship a stale/unpinned prewarm SDK green.
RUN cd /opt/codeflare/pi-agent/npm && \
    apt-get update && \
    apt-get install -y --no-install-recommends make gcc g++ && \
    export PI_VER="$(node -p "require('/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/package.json').version")" && \
    [ -n "$PI_VER" ] || { echo "ERROR: could not read global Pi SDK version - refusing to ship an unpinned prewarm tree" >&2; exit 1; } && \
    echo "Bridging prewarm Pi SDK to global agent version: $PI_VER" && \
    node -e 'const f="package.json",p=require(process.cwd()+"/"+f);(p.overrides=p.overrides||{})["@earendil-works/pi-coding-agent"]=process.env.PI_VER;require("fs").writeFileSync(f,JSON.stringify(p,null,2)+"\n")' && \
    rm -f package-lock.json && \
    npm install --omit=dev --no-audit --no-fund && \
    INSTALLED_PI_VER="$(node -p "require('/opt/codeflare/pi-agent/npm/node_modules/@earendil-works/pi-coding-agent/package.json').version")" && \
    [ "$INSTALLED_PI_VER" = "$PI_VER" ] || { echo "ERROR: prewarm Pi SDK $INSTALLED_PI_VER != global $PI_VER - version bridge did not take" >&2; exit 1; } && \
    echo "Prewarm Pi SDK pinned to $INSTALLED_PI_VER (matches global agent)" && \
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
# Pinned here in the Dockerfile rather than tracked as an ARG: context-mode autodetects Bun at
# runtime and substitutes it for Node in the JS/TS subprocess path. The
# bump-shadow-pins workflow watches this Dockerfile literal and opens a PR;
# smoke-test ctx_execute before merging if a future Bun release changes startup
# behavior.
RUN npm install -g bun@1.3.14 && \
    bun --version && \
    # Strip 258MB of non-linux platform binaries shipped in bun's npm package.
    # Only the linux-x64 binary (bun.exe / bunx.exe hardlinked in bin/) is needed.
    rm -rf /usr/local/lib/node_modules/bun/node_modules && \
    npm cache clean --force && rm -rf /root/.npm

# Install context-mode globally and patch the esbuild ESM bundles in place via
# scripts/patch-context-mode-bundles.mjs (the SAME module host/__tests__ imports,
# so the patch logic and its test cannot drift). Implements REQ-AGENT-005 AC5
# (createRequire shim, codeflare#309) + AC8 (npm update-check notice disable); the
# full rationale lives in that script's header. Done at build time so the patched
# bundles ship in the image — no runtime extraction, no per-session bunx download,
# no first-call delay. License posture (ELv2): we do NOT redistribute context-mode
# source; npm pulls it from the public registry at build time exactly as
# `npx -y context-mode` would, and we only edit the installed bundle in place.
COPY preseed/agents/claude/plugins/context-mode/.claude-plugin/plugin.json /tmp/context-mode-plugin.json
COPY scripts/patch-context-mode-bundles.mjs /tmp/patch-context-mode-bundles.mjs
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
node /tmp/patch-context-mode-bundles.mjs "$CTX_DIR"
# Pi loads context-mode as an `npm:context-mode@<ver>` PACKAGE (preseed/agents/pi
# settings.json + package.json), resolved at runtime from ~/.pi/agent/npm/node_modules,
# which the entrypoint SYMLINKS to this build-time prewarm tree (PI_OFFLINE=1 — no runtime
# reinstall). So the Pi copy MUST be patched here too, else Pi sessions hit the live npm
# update-probe (the "Update available … ctx_upgrade" chat spam) + miss the createRequire
# shim (ctx_execute "Dynamic require of node:*"). The global (Claude MCP bin) and the Pi
# package copy are separate installs with separate version pins — assert they match so a
# Dependabot bump to one without the other (preseed/agents/pi/package.json vs plugin.json)
# FAILS the build instead of silently shipping a half-patched/mismatched pair.
PI_CTX_DIR="/opt/codeflare/pi-agent/npm/node_modules/context-mode"
PI_CTX_VER="$(node -p "require('$PI_CTX_DIR/package.json').version")"
if [ "$PI_CTX_VER" != "$VER" ]; then
  echo "[Dockerfile] FATAL: Pi context-mode $PI_CTX_VER != plugin.json $VER — bump preseed/agents/pi/package.json and plugin.json together" >&2
  exit 1
fi
node /tmp/patch-context-mode-bundles.mjs "$PI_CTX_DIR"
# Smoke-test BOTH bundles in BOTH installs so a regression in server.bundle.mjs surfaces
# at build time. cli.bundle.mjs is exercised by `--version`.
context-mode --version
node -e "import('/usr/local/lib/node_modules/context-mode/server.bundle.mjs').catch(e => { console.error('[Dockerfile] FATAL: server.bundle.mjs import failed:', e.message); process.exit(1); }).then(() => console.log('[Dockerfile] server.bundle.mjs imports cleanly'))"
node -e "import('/opt/codeflare/pi-agent/npm/node_modules/context-mode/server.bundle.mjs').catch(e => { console.error('[Dockerfile] FATAL: Pi server.bundle.mjs import failed:', e.message); process.exit(1); }).then(() => console.log('[Dockerfile] Pi server.bundle.mjs imports cleanly'))"
rm -f /tmp/context-mode-plugin.json /tmp/patch-context-mode-bundles.mjs
npm cache clean --force
rm -rf /root/.npm
EOF

# ---------------------------------------------------------------------------
# Pre-warm the consult-llm-mcp MCP server (used by Claude Code + Pi via the
# consult-llm MCP config in entrypoint.sh). Installing it globally at build time
# means the runtime MCP command invokes the global bin from /usr/local/bin with
# no per-session `npx -y` registry fetch / first-call delay (same pattern as the
# context-mode + agent-CLI globals). Pinned and shadow-tracked by
# the `consult-llm-mcp` job in .github/workflows/bump-shadow-pins.yml, since a
# Dockerfile `npm install -g` literal is invisible to Dependabot. In Enterprise
# Mode the MCP config is not written (consult-llm is disabled), so this baked
# binary is simply unused there — harmless.
RUN npm install -g consult-llm-mcp@2.13.4 && \
    command -v consult-llm-mcp >/dev/null || { echo "[Dockerfile] FATAL: consult-llm-mcp not on PATH after install" >&2; exit 1; } && \
    npm cache clean --force && \
    rm -rf /root/.npm

# ---------------------------------------------------------------------------
# Browser Run interactive MCP server (chrome-devtools-mcp).
# Claude Code does not support Pi's `lifecycle: "lazy"` process-start contract,
# so a runtime `npx -y chrome-devtools-mcp@...` forces Claude sessions to pay a
# cold npm resolve/download/extract path on first startup (npm cache is excluded
# from R2 and purged at boot). Bake the pinned npx install into /opt/codeflare
# and expose a stable bin path. The shadow-pin workflow updates ONLY
# CHROME_DEVTOOLS_MCP_VERSION; the image rebuild then regenerates the matching
# cache and smoke-tests the bin, so a future bump cannot ship a stale cache.
ENV CHROME_DEVTOOLS_MCP_VERSION=1.6.0
ENV CHROME_DEVTOOLS_MCP_NPX_CACHE=/opt/codeflare/chrome-devtools-mcp-npx-cache
ENV CHROME_DEVTOOLS_MCP_BIN=/opt/codeflare/bin/chrome-devtools-mcp
RUN mkdir -p "$CHROME_DEVTOOLS_MCP_NPX_CACHE" "$(dirname "$CHROME_DEVTOOLS_MCP_BIN")" && \
    NPM_CONFIG_CACHE="$CHROME_DEVTOOLS_MCP_NPX_CACHE" \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    npx -y "chrome-devtools-mcp@$CHROME_DEVTOOLS_MCP_VERSION" --help >/dev/null && \
    MCP_BIN_LINK="$(find "$CHROME_DEVTOOLS_MCP_NPX_CACHE/_npx" -path '*/node_modules/.bin/chrome-devtools-mcp' -print -quit)" && \
    [ -n "$MCP_BIN_LINK" ] || { echo "[Dockerfile] FATAL: chrome-devtools-mcp bin missing from baked npx cache" >&2; exit 1; } && \
    MCP_BIN="$(readlink -f "$MCP_BIN_LINK")" && \
    [ -x "$MCP_BIN" ] || { echo "[Dockerfile] FATAL: chrome-devtools-mcp bin not executable in baked npx cache" >&2; exit 1; } && \
    ln -sf "$MCP_BIN" "$CHROME_DEVTOOLS_MCP_BIN" && \
    "$CHROME_DEVTOOLS_MCP_BIN" --help >/dev/null && \
    rm -rf "$CHROME_DEVTOOLS_MCP_NPX_CACHE/_logs" /root/.npm

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
# This speeds up first-launch of Node.js CLIs inside containers by avoiding the
# compilation overhead on every container start.
# Note: Go binaries (like opencode and antigravity) don't need this — they're already natively compiled.
#
# Owner decision (image-size): the codex + copilot compile-cache warm-ups are
# DEACTIVATED so their bytecode is not baked into the image (build-space saving);
# their first launch pays the compile cost instead. Claude Code (its own --version
# verify above) and Pi (here, plus the jiti extension warm below) keep their prewarm.
# Re-enable by restoring the two commented lines into the RUN.
#   codex --version 2>&1 || true && \
#   copilot --version 2>&1 || true && \
RUN pi --version 2>&1 || true

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
# - jiti's cache key is PATH-SENSITIVE, not just content: the cache filename is
#   <flatpath>.<hash(abspath + source + jiti version)>.mjs. Proven empirically —
#   identical bytes at two different paths produce two different cache entries. So
#   the warm run MUST transpile each extension at the EXACT path Pi loads it from
#   at runtime (/home/user/.pi/agent/extensions/<x>.ts); a different warm path
#   (the old /tmp/pi-warm) hashes differently and the entry NEVER hits — which is
#   why every advanced session cold-transpiled its extensions. npm packages hit
#   regardless because both warm and runtime resolve them through a symlink to the
#   same realpath /opt/codeflare/pi-agent/npm; extensions are real files, so their
#   path must match — hence PI_CODING_AGENT_DIR/HOME are the real runtime values
#   here, not a throwaway tmpdir. (Content must ALSO match at runtime; the
#   entrypoint relay of the managed extensions guarantees that half.)
# - The agent dir mirrors the runtime layout (npm symlinked to the image preseed
#   cache, exactly like the entrypoint does); the package list is DERIVED from the
#   preseed package.json so a version bump there warms the right set automatically.
#   The warm artifacts under /home/user/.pi are removed after the cache is moved
#   out, so nothing is baked into /home/user.
# - The pi run exits non-zero on the missing-LLM-key model call AFTER
#   extensions load (|| true); the mv + final test fail the build if the cache
#   came out empty, so a pi CLI change that breaks the warm-up is caught at
#   build, not as a silent startup regression in production.
# - Fail-closed completeness check: the build asserts that EVERY Pi extension
#   produced a baked cache entry (jiti names them extensions-<base>.<hash>.mjs).
#   So a future extension that is added, modified into a non-loading state, or
#   skipped by a pi-loader change fails the build instead of silently
#   cold-transpiling every session in production. This enforces "the prewarm
#   cache covers everything, every deploy".
RUN mkdir -p /opt/codeflare/jiti-warm-tmp /home/user/.pi/agent && \
    ln -s /opt/codeflare/pi-agent/npm /home/user/.pi/agent/npm && \
    cp -r /opt/codeflare/pi-agent/extensions /home/user/.pi/agent/extensions && \
    node -e 'const d=require("/opt/codeflare/pi-agent/npm/package.json").dependencies;process.stdout.write(JSON.stringify({packages:Object.entries(d).map(([n,v])=>`npm:${n}@${v}`)}))' > /home/user/.pi/agent/settings.json && \
    (TMPDIR=/opt/codeflare/jiti-warm-tmp HOME=/home/user PI_CODING_AGENT_DIR=/home/user/.pi/agent PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 timeout 240 pi -p "warm" || true) && \
    mv /opt/codeflare/jiti-warm-tmp/jiti /opt/codeflare/jiti-cache && \
    rm -rf /opt/codeflare/jiti-warm-tmp /home/user/.pi && \
    test -n "$(ls -A /opt/codeflare/jiti-cache)" && \
    for ext in /opt/codeflare/pi-agent/extensions/*.ts; do \
        [ -e "$ext" ] || continue; \
        base="$(basename "$ext" .ts)"; \
        hit="$(ls /opt/codeflare/jiti-cache/extensions-"$base".*.mjs 2>/dev/null | head -1)"; \
        if [ -n "$hit" ]; then echo "[Dockerfile]   jiti-cached: $base -> $(basename "$hit")"; \
        else echo "ERROR: Pi extension '$base' has no jiti warm-cache entry — it would cold-transpile every session; failing build" >&2; exit 1; fi; \
    done && \
    echo "[Dockerfile] jiti warm cache verified: every Pi extension is baked"

# Pre-initialize OpenCode's SQLite database to skip Goose migrations on first launch.
# OpenCode stores its DB at ~/.local/share/opencode/opencode.db (XDG data dir) and runs
# schema migrations on every startup. Running `opencode run` at build time triggers the
# migration ("Performing one time database migration") so first interactive launch is fast.
# Unset all provider keys so the migration runs without making an actual LLM call.
# GitHub Actions injects GITHUB_TOKEN which OpenCode would use for GitHub Models.
# Owner decision (image-size): DEACTIVATED — this warm-up baked ~147MB of opencode
# data into the image. OpenCode now runs its one-time DB migration on first launch
# instead. Re-enable by uncommenting the RUN below.
# RUN ANTHROPIC_API_KEY="" OPENAI_API_KEY="" GEMINI_API_KEY="" GITHUB_TOKEN="" \
#     timeout 30 opencode run "hello" 2>&1 || true

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
