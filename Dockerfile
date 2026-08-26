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
COPY openvscode/agent-sidebar/tsconfig.json openvscode/agent-sidebar/esbuild.mjs openvscode/agent-sidebar/official-claude.json openvscode/agent-sidebar/welcome-package.json ./
COPY openvscode/extension-persistence-policy.json ../extension-persistence-policy.json
COPY openvscode/claude/managed-settings.mjs openvscode/claude/managed-settings.d.mts ../claude/
COPY openvscode/agent-sidebar/src/ ./src/
RUN npm run typecheck && NODE_ENV=production npm run build

RUN mkdir -p /out/extension /out/welcome/dist && \
    cp package.json /out/extension/package.json && \
    cp -a dist /out/extension/dist && \
    rm /out/extension/dist/welcome-extension.cjs && \
    cp welcome-package.json /out/welcome/package.json && \
    cp dist/welcome-extension.cjs /out/welcome/dist/welcome-extension.cjs
COPY openvscode/agent-sidebar/media/ /out/extension/media/
COPY openvscode/agent-sidebar/media/ /out/welcome/media/

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
RUN LAZYGIT_VERSION="0.64.1" && \
    LAZYGIT_SHA256="f8ea237c41f194cd799b48505518bfdaae4edf5a2ad6bd3d898e939785ee4532" && \
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
RUN SILVERBULLET_VERSION="2.10.0" && \
    SILVERBULLET_SHA256="ca33f7de3bae2f2e7d95cdd2cca1a023e51267388c9dbc8ff5acc33b1cbd5a7d" && \
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
# the immutable release tag and owns the five code-server literals below.
# code-server 4.132.0 vendors js-yaml 4.3.0 within its declared ^4.1.0 range;
# the overlay pins 4.3.1 under an independent integrity hash as defence in
# depth. The immutable Node and code-server artifacts also carry node-tar
# versions affected by CVE-2026-73566, so one integrity-pinned 7.5.21 artifact
# replaces both runtime copies. Drop each overlay after its upstream artifact
# contains at least the pinned fixed version.
RUN CODE_SERVER_VERSION="4.132.0" && \
    CODE_SERVER_SHA256="a38d26f4cb81f768feddff79e2937fd3f39c83d3da8be3da7225e1087e62e4ed" && \
    CODE_SERVER_COMMIT="313bf0359b4d391ba18f1fa131aad8a583bc2919" && \
    CODE_SERVER_CODE_VERSION="1.132.0" && \
    CODE_SERVER_VSCODE_COMMIT="df53daabb18cd157bdb08c7f01c34df936cf12f4" && \
    JS_YAML_VERSION="4.3.1" && \
    JS_YAML_SHA512="098e9cac6ab7d77317f06930bc1eedce0a7df6f8d0c58d7efb9cb5d3f04a37f1947c7a9668e19030d66406fa92cec64a5a4fe28f01e55b3ce42ee96c18786359" && \
    NODE_TAR_VERSION="7.5.21" && \
    NODE_TAR_SHA512="5dd86d0af94ccb0c31a425bc604ab794e5c126950f4d1d8e1c77302cf3b71f0b09a8e1dad8e93fa09eebb86ce9f89acaa113d50b327001d123a8b5bfbcd44f1c" && \
    curl -fsSL --retry 3 --retry-delay 5 --connect-timeout 30 --max-time 600 \
      "https://github.com/coder/code-server/releases/download/v${CODE_SERVER_VERSION}/code-server-${CODE_SERVER_VERSION}-linux-amd64.tar.gz" \
      -o /tmp/code-server.tar.gz && \
    echo "${CODE_SERVER_SHA256}  /tmp/code-server.tar.gz" | sha256sum -c - && \
    curl -fsSL --retry 3 --retry-delay 5 --connect-timeout 30 --max-time 300 \
      "https://registry.npmjs.org/js-yaml/-/js-yaml-${JS_YAML_VERSION}.tgz" \
      -o /tmp/js-yaml.tgz && \
    echo "${JS_YAML_SHA512}  /tmp/js-yaml.tgz" | sha512sum -c - && \
    curl -fsSL --retry 3 --retry-delay 5 --connect-timeout 30 --max-time 300 \
      "https://registry.npmjs.org/tar/-/tar-${NODE_TAR_VERSION}.tgz" \
      -o /tmp/node-tar.tgz && \
    echo "${NODE_TAR_SHA512}  /tmp/node-tar.tgz" | sha512sum -c - && \
    mkdir -p /opt/code-server && \
    tar -xzf /tmp/code-server.tar.gz -C /opt/code-server --strip-components=1 && \
    rm -rf /opt/code-server/node_modules/js-yaml && \
    mkdir -p /opt/code-server/node_modules/js-yaml && \
    tar -xzf /tmp/js-yaml.tgz -C /opt/code-server/node_modules/js-yaml --strip-components=1 && \
    test "$(jq -r .version /opt/code-server/node_modules/js-yaml/package.json)" = "$JS_YAML_VERSION" && \
    for NODE_TAR_DIR in \
        /usr/local/lib/node_modules/npm/node_modules/tar \
        /opt/code-server/lib/vscode/node_modules/tar; do \
      rm -rf "$NODE_TAR_DIR" && \
      mkdir -p "$NODE_TAR_DIR" && \
      tar -xzf /tmp/node-tar.tgz -C "$NODE_TAR_DIR" --strip-components=1 && \
      test "$(jq -r .version "$NODE_TAR_DIR/package.json")" = "$NODE_TAR_VERSION"; \
    done && \
    npm --version >/dev/null && \
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
    rm -f /tmp/code-server.tar.gz /tmp/js-yaml.tgz /tmp/node-tar.tgz

# Install the selected shared coding-agent launchers. IS_SANDBOX=1 allows
# permissions bypass inside the container. .cache-bust invalidates this layer on
# requested fresh builds; exact versions come from the committed npm-tool lock or
# Antigravity checksum. Pi's separate prewarm/Jiti installation below is always
# retained and does not depend on the optional shared Pi launcher.
COPY .cache-bust /tmp/.cache-bust

# Preseed SilverBullet config + (best-effort) Atlas plug. entrypoint.sh copies
# these into /home/user/Vault/.silverbullet/ on first session boot.
# Atlas plug is optional; vault visualisation falls back to graphify-out/graph.html
# if atlas.plug.js is not present.
COPY preseed/silverbullet/ /opt/silverbullet-preseed/

# Install gh CLI (after .cache-bust so every deploy re-resolves the apt version)
RUN apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# Privileged npm tools execute user code, hold OAuth tokens, or participate in
# image builds. Install from one committed lock so exact package bytes and
# transitive dependencies remain reviewable. CODEFLARE_CODING_AGENTS selects
# only shared launchers; Pi prewarm/Jiti and native IDE assets remain below.
ARG CODEFLARE_CODING_AGENTS=claude-code,codex,copilot,antigravity,opencode,pi
ENV CODEFLARE_CODING_AGENTS=${CODEFLARE_CODING_AGENTS}
COPY preseed/npm-tools/package.json preseed/npm-tools/package-lock.json /opt/codeflare/npm-tools/
COPY image/oxlint/package.json image/oxlint/package-lock.json /opt/codeflare/oxlint/
COPY scripts/ci/coding-agent-selection.mjs scripts/ci/prune-npm-platform-artifacts.mjs /opt/codeflare/scripts/
RUN cd /opt/codeflare/oxlint && \
    npm ci --omit=dev --ignore-scripts --no-audit --no-fund && \
    node /opt/codeflare/scripts/prune-npm-platform-artifacts.mjs node_modules && \
    [ -e node_modules/.bin/oxlint ] && \
    ln -sf "$(readlink -f node_modules/.bin/oxlint)" /usr/local/bin/oxlint && \
    oxlint --version
RUN cd /opt/codeflare/npm-tools && \
    CODEFLARE_CODING_AGENTS="$(node /opt/codeflare/scripts/coding-agent-selection.mjs resolve "$CODEFLARE_CODING_AGENTS")" && \
    npm ci --omit=dev --no-audit --no-fund && \
    cp package.json /tmp/npm-tools-package.json && \
    cp package-lock.json /tmp/npm-tools-package-lock.json && \
    node /opt/codeflare/scripts/coding-agent-selection.mjs select-manifest "$CODEFLARE_CODING_AGENTS" package.json && \
    npm prune --omit=dev --ignore-scripts --no-audit --no-fund && \
    mv /tmp/npm-tools-package.json package.json && \
    mv /tmp/npm-tools-package-lock.json package-lock.json && \
    for b in bun bunx context-mode consult-llm-mcp chrome-devtools-mcp; do \
      [ -e "node_modules/.bin/$b" ] || { echo "ERROR: locked npm tool '$b' has no bin" >&2; exit 1; }; \
      ln -sf "$(readlink -f "node_modules/.bin/$b")" "/usr/local/bin/$b"; \
    done && \
    for entry in claude:claude-code codex:codex copilot:copilot opencode:opencode pi:pi; do \
      bin="${entry%%:*}"; agent="${entry#*:}"; \
      if node /opt/codeflare/scripts/coding-agent-selection.mjs has "$CODEFLARE_CODING_AGENTS" "$agent"; then \
        [ -e "node_modules/.bin/$bin" ] || { echo "ERROR: selected npm agent '$agent' has no '$bin' bin" >&2; exit 1; }; \
        ln -sf "$(readlink -f "node_modules/.bin/$bin")" "/usr/local/bin/$bin"; \
      else \
        [ ! -e "node_modules/.bin/$bin" ] || { echo "ERROR: omitted npm agent '$agent' remains installed" >&2; exit 1; }; \
      fi; \
    done && \
    mkdir -p /opt/codeflare/bin && \
    ln -sf /usr/local/bin/chrome-devtools-mcp /opt/codeflare/bin/chrome-devtools-mcp && \
    node /opt/codeflare/scripts/prune-npm-platform-artifacts.mjs node_modules && \
    if [ -d node_modules/@github/copilot/prebuilds ]; then \
      find node_modules/@github/copilot/prebuilds/ -maxdepth 1 -type d ! -name 'prebuilds' ! -name 'linux-x64' -exec rm -rf {} +; \
      rm -rf node_modules/@github/copilot/mxc-bin/arm64 node_modules/@github/copilot/ripgrep/ \
        node_modules/@github/copilot/clipboard/node_modules node_modules/@github/copilot/pvrecorder/node_modules \
        node_modules/@github/copilot/sharp/node_modules; \
    fi && \
    rm -rf node_modules/@oven && \
    bun --version && \
    chrome-devtools-mcp --help >/dev/null && \
    rm -f /tmp/.cache-bust && \
    npm cache clean --force && \
    rm -rf /tmp/* /root/.npm

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
RUN if node /opt/codeflare/scripts/coding-agent-selection.mjs has "$CODEFLARE_CODING_AGENTS" antigravity; then \
      curl -fsSL https://antigravity.google/cli/install.sh -o /tmp/agy-install.sh && \
      echo "${ANTIGRAVITY_INSTALLER_SHA256}  /tmp/agy-install.sh" | sha256sum -c - && \
      bash /tmp/agy-install.sh && \
      AGY_BIN=$(command -v agy || find / -name 'agy' -type f -perm -u+x 2>/dev/null | grep -v '/proc/' | head -1) && \
      [ -n "$AGY_BIN" ] || { echo "ERROR: agy binary not found after antigravity install" >&2; exit 1; } && \
      if [ "$AGY_BIN" != "/usr/local/bin/agy" ]; then ln -sf "$AGY_BIN" /usr/local/bin/agy; fi && \
      agy --version; \
    else \
      echo "Antigravity omitted by CODEFLARE_CODING_AGENTS"; \
    fi && \
    rm -rf /tmp/*

# Preinstall Pi extension npm dependencies into an image-local seed cache.
# ~/.pi/agent/npm/node_modules is excluded from R2 sync, so without this Pi
# would run a slow npm install on first launch (~90s on mobile). Entrypoint
# symlinks node_modules to this cache (instant, zero-copy).
# Caveman policy is image-owned and deliberately excluded from agent seeds.
COPY image/pi/caveman.json /opt/codeflare/pi-agent/caveman.json
COPY preseed/agents/pi/package.json preseed/agents/pi/package-lock.json /opt/codeflare/pi-agent/npm/
COPY scripts/verify-pi-lockstep.mjs scripts/patch-pi-goal-review-control.mjs /opt/codeflare/scripts/
# better-sqlite3 / bufferutil / utf-8-validate are native (node-gyp) modules. Their
# prebuilt-binary fetch is best-effort and falls back to a source compile, which needs
# make + a C/C++ toolchain. stage-1 ships python3 but not make/gcc/g++ (those live only
# in the discarded builder), so a prebuilt-fetch miss fails with "not found: make".
# Install the toolchain just for this install and purge it in the same layer (mirroring
# the graphify-build pattern below) so the runtime image stays lean.
#
# Keep prewarm Pi in lockstep with the runtime agent while preserving committed
# package integrity. The image fails closed on manifest drift.
RUN cd /opt/codeflare/pi-agent/npm && \
    node /opt/codeflare/scripts/verify-pi-lockstep.mjs \
      /opt/codeflare/npm-tools/package.json ./package.json && \
    apt-get update && \
    apt-get install -y --no-install-recommends make gcc g++ && \
    npm ci --omit=dev --no-audit --no-fund && \
    GOAL_VERSION="$(node -p 'require("./package.json").dependencies["@narumitw/pi-goal"]')" && \
    node /opt/codeflare/scripts/patch-pi-goal-review-control.mjs \
      "$GOAL_VERSION" ./node_modules/@narumitw/pi-goal && \
    node /opt/codeflare/scripts/verify-pi-lockstep.mjs \
      /opt/codeflare/npm-tools/package.json ./package.json \
      ./node_modules/@earendil-works/pi-coding-agent/package.json && \
    apt-get purge -y make gcc g++ && \
    apt-get autoremove -y && \
    npm cache clean --force && \
    rm -rf /root/.npm /var/lib/apt/lists/*

# Patch the lock-installed context-mode esbuild bundles in place via
# scripts/patch-context-mode-bundles.mjs (the SAME module host/__tests__ imports,
# so the patch logic and its test cannot drift). Implements REQ-AGENT-005 AC5
# (createRequire shim, codeflare#309) + AC8 (npm update-check notice disable); the
# full rationale lives in that script's header. Done at build time so the patched
# bundles ship in the image — no runtime extraction, no per-session bunx download,
# no first-call delay. License posture (ELv2): we do NOT redistribute context-mode
# source; npm pulls it from the public registry at build time through the
# committed lock, and we only edit the installed bundle in place.
COPY preseed/agents/claude/plugins/context-mode/.claude-plugin/plugin.json /tmp/context-mode-plugin.json
COPY scripts/patch-context-mode-bundles.mjs /tmp/patch-context-mode-bundles.mjs
RUN <<'EOF'
set -e
VER=$(jq -r '.version // empty' /tmp/context-mode-plugin.json)
if [ -z "$VER" ]; then
  echo "[Dockerfile] FATAL: plugin.json has no .version field; build cannot proceed" >&2
  exit 1
fi
# Pi loads a separate prewarm copy, so the shared executable validates both
# installed versions against plugin.json before patching either installation.
CTX_DIR="/opt/codeflare/npm-tools/node_modules/context-mode"
PI_CTX_DIR="/opt/codeflare/pi-agent/npm/node_modules/context-mode"
node /tmp/patch-context-mode-bundles.mjs "$VER" "$CTX_DIR" "$PI_CTX_DIR"
# Smoke-test BOTH bundles in BOTH installs so a regression in server.bundle.mjs surfaces
# at build time. cli.bundle.mjs is exercised by `--version`.
context-mode --version
node -e "import('/opt/codeflare/npm-tools/node_modules/context-mode/server.bundle.mjs').catch(e => { console.error('[Dockerfile] FATAL: server.bundle.mjs import failed:', e.message); process.exit(1); }).then(() => console.log('[Dockerfile] server.bundle.mjs imports cleanly'))"
node -e "import('/opt/codeflare/pi-agent/npm/node_modules/context-mode/server.bundle.mjs').catch(e => { console.error('[Dockerfile] FATAL: Pi server.bundle.mjs import failed:', e.message); process.exit(1); }).then(() => console.log('[Dockerfile] Pi server.bundle.mjs imports cleanly'))"
rm -f /tmp/context-mode-plugin.json /tmp/patch-context-mode-bundles.mjs
npm cache clean --force
rm -rf /root/.npm
EOF

ENV CHROME_DEVTOOLS_MCP_BIN=/opt/codeflare/bin/chrome-devtools-mcp

# ---------------------------------------------------------------------------
# Claude-side Browser Run MCP server (REQ-BROWSER-005). The analog of Pi's
# native browser-run.ts extension: exposes the Cloudflare Browser Run REST Quick
# Actions (markdown / content / scrape) as MCP tools so Claude has the same cheap
# one-shot page-read surface Pi has. chrome-devtools-mcp gives Claude the
# interactive surface; this gives it the clean HTML->Markdown / scrape surface.
# Registered in ~/.claude.json by entrypoint.sh under the same advanced + CF-token
# gate. The @modelcontextprotocol/sdk version in package.json is pinned (exact)
# and shadow-pinned (the `browser-run-mcp` job in bump-shadow-pins.yml bumps it
# weekly; its committed lock preserves registry integrity). Built here so the
# runtime invokes `node /opt/codeflare/browser-run-mcp/index.mjs` with no fetch.
COPY preseed/agents/claude/browser-run-mcp/package.json preseed/agents/claude/browser-run-mcp/package-lock.json /opt/codeflare/browser-run-mcp/
RUN cd /opt/codeflare/browser-run-mcp && \
    npm ci --omit=dev --no-audit --no-fund && \
    npm cache clean --force && \
    rm -rf /root/.npm
COPY preseed/agents/claude/browser-run-mcp/core.d.mts preseed/agents/claude/browser-run-mcp/core.mjs preseed/agents/claude/browser-run-mcp/index.mjs /opt/codeflare/browser-run-mcp/
RUN node -e "import('/opt/codeflare/browser-run-mcp/index.mjs').then(() => console.log('[Dockerfile] browser-run-mcp imports cleanly')).catch(e => { console.error('[Dockerfile] FATAL: browser-run-mcp import failed:', e.message); process.exit(1); })"

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
ARG UV_VERSION=0.12.3
ARG UV_X86_64_LINUX_SHA256=600cf9a742aca00d292673b16b5acffaa7b8c269a364ad0c2e79498dcb1fe101
COPY preseed/agents/claude/plugins/graphify/.claude-plugin/plugin.json /tmp/graphify-plugin.json
RUN <<'EOF'
set -e
# Install uv from an immutable GitHub release artifact. The committed digest is
# verified before extraction; no network-fetched installer script executes.
UV_ARCHIVE=/tmp/uv-x86_64-unknown-linux-gnu.tar.gz
curl -fsSL "https://github.com/astral-sh/uv/releases/download/${UV_VERSION}/uv-x86_64-unknown-linux-gnu.tar.gz" -o "$UV_ARCHIVE"
echo "${UV_X86_64_LINUX_SHA256}  $UV_ARCHIVE" | sha256sum -c -
mkdir -p /root/.local/bin
tar -xzf "$UV_ARCHIVE" -C /tmp
install -m 0755 /tmp/uv-x86_64-unknown-linux-gnu/uv /root/.local/bin/uv
rm -rf "$UV_ARCHIVE" /tmp/uv-x86_64-unknown-linux-gnu
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
# their first launch pays the compile cost instead. Selected Claude Code is
# verified in the packaged-image smoke. Pi's dedicated prewarm binary below runs
# regardless of shared launcher selection so its Jiti cache remains complete.
# Re-enable by restoring the two commented lines into the RUN.
#   codex --version 2>&1 || true && \
#   copilot --version 2>&1 || true && \
RUN /opt/codeflare/pi-agent/npm/node_modules/.bin/pi --version

# Local Pi extensions are copied only after dependency/tool installation, so an
# extension-only edit invalidates Jiti prewarm and later assembly rather than the
# expensive Pi npm/toolchain and unrelated runtime layers. They reach user
# containers through the R2 seed verbatim, preserving warm-cache content keys.
COPY preseed/agents/pi/extensions/ /opt/codeflare/pi-agent/extensions/

# Pi extension warm-up: pre-transpile the full Pi extension set (npm packages +
# local preseed extensions) into a baked jiti cache + the V8 compile cache.
# The dedicated Pi `--version` above does NOT load extensions; without this layer every fresh
# container paid ~9s of cold jiti transpile before Pi's first PTY output,
# pushing the host's pre-warm past its 20s hard cap (session startup 15s ->
# 30-35s after the 6-package preseed bundle shipped). Mechanics, all validated
# against the live container:
# - jiti caches transpiles under $TMPDIR/jiti (its path-valued JITI_FS_CACHE
#   env is ignored by this build), so the warm run redirects TMPDIR and the
#   result is moved to /opt/codeflare/jiti-cache; the entrypoint symlinks
#   $TMPDIR/jiti -> there under a stable /run root before the terminal host starts.
# - jiti's cache key is PATH-SENSITIVE, not just content: its async cache filename
#   is <parent>-<base>.<hash(realpath)>.mjs, while the compiled output carries the
#   source/version marker used to reject stale content. So the warm run MUST
#   transpile each extension at the EXACT path Pi loads it from
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
# - Fail-closed completeness check: the build asserts that every local Pi extension
#   produced an extensions-<base>.<hash>.mjs entry. A dedicated explicit extension
#   load transpiles Goal's installed entrypoint even when another package reports a
#   non-fatal startup error; the build then derives and requires exact regular-file
#   artifacts for Goal, Plan Mode, Usage, Evaluate, and Caveman. A future extension that is added, modified into a non-loading state,
#   or skipped by a pi-loader change therefore fails the build instead of silently
#   cold-transpiling every production session.
RUN mkdir -p /opt/codeflare/jiti-warm-tmp /home/user/.pi/agent && \
    ln -s /opt/codeflare/pi-agent/npm /home/user/.pi/agent/npm && \
    cp -r /opt/codeflare/pi-agent/extensions /home/user/.pi/agent/extensions && \
    PI_WARM_PACKAGES="$(node -e 'const d=require("/opt/codeflare/pi-agent/npm/package.json").dependencies;process.stdout.write(JSON.stringify({packages:Object.entries(d).map(([n,v])=>`npm:${n}@${v}`)}))')" && \
    printf '%s' "$PI_WARM_PACKAGES" > /home/user/.pi/agent/settings.json && \
    goal_source="/opt/codeflare/pi-agent/npm/node_modules/@narumitw/pi-goal/src/index.ts" && \
    plan_source="/opt/codeflare/pi-agent/npm/node_modules/@narumitw/pi-plan-mode/dist/index.ts" && \
    usage_source="/opt/codeflare/pi-agent/npm/node_modules/@narumitw/pi-usage/src/index.ts" && \
    evaluate_source="/opt/codeflare/pi-agent/npm/node_modules/pi-evaluate/extensions/evaluate.ts" && \
    caveman_source="/opt/codeflare/pi-agent/npm/node_modules/pi-caveman/extensions/caveman.ts" && \
    (TMPDIR=/opt/codeflare/jiti-warm-tmp HOME=/home/user PI_CODING_AGENT_DIR=/home/user/.pi/agent PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 timeout 240 /opt/codeflare/pi-agent/npm/node_modules/.bin/pi -p "warm" || true) && \
    TMPDIR=/opt/codeflare/jiti-warm-tmp HOME=/home/user PI_CODING_AGENT_DIR=/home/user/.pi/agent PI_OFFLINE=1 PI_SKIP_VERSION_CHECK=1 \
      node /opt/codeflare/scripts/verify-pi-lockstep.mjs --warm-jiti-entrypoints \
      /opt/codeflare/pi-agent/npm/node_modules/.bin/pi /opt/codeflare/jiti-warm-tmp/jiti "$goal_source" "$plan_source" "$usage_source" "$evaluate_source" "$caveman_source" && \
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
    goal_hit="$(node /opt/codeflare/scripts/verify-pi-lockstep.mjs --verify-jiti-cache "$goal_source" /opt/codeflare/jiti-cache)" && \
    plan_hit="$(node /opt/codeflare/scripts/verify-pi-lockstep.mjs --verify-jiti-cache "$plan_source" /opt/codeflare/jiti-cache)" && \
    usage_hit="$(node /opt/codeflare/scripts/verify-pi-lockstep.mjs --verify-jiti-cache "$usage_source" /opt/codeflare/jiti-cache)" && \
    evaluate_hit="$(node /opt/codeflare/scripts/verify-pi-lockstep.mjs --verify-jiti-cache "$evaluate_source" /opt/codeflare/jiti-cache)" && \
    caveman_hit="$(node /opt/codeflare/scripts/verify-pi-lockstep.mjs --verify-jiti-cache "$caveman_source" /opt/codeflare/jiti-cache)" && \
    echo "[Dockerfile] jiti warm cache verified: local extensions, Goal, Plan Mode, Usage, Evaluate, and Caveman are baked"

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

# Codeflare's non-agent welcome surface is available for every fixed inventory.
# It is packaged as owned extension code without modifying code-server or Code OSS.
COPY --from=openvscode-agent-sidebar-builder /out/welcome /opt/code-server/lib/vscode/extensions/codeflare-welcome
RUN test -f /opt/code-server/lib/vscode/extensions/codeflare-welcome/dist/welcome-extension.cjs && \
    chmod -R a-w /opt/code-server/lib/vscode/extensions/codeflare-welcome

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
COPY scripts/browser-ide-ui-state.py scripts/browser-ide-extensions.py /opt/codeflare/openvscode/
COPY openvscode/extension-persistence-policy.json /opt/codeflare/openvscode/extension-persistence-policy.json
RUN chmod 0444 /opt/codeflare/openvscode/smoke-openvscode-sidebar-image.mjs \
        /opt/codeflare/openvscode/extension-persistence-policy.json && \
    chmod 0555 /opt/codeflare/openvscode/browser-ide-ui-state.py \
        /opt/codeflare/openvscode/browser-ide-extensions.py

# REQ-STOR-017 / AD90: bake the agent-config seed tree into the image so a Governed Mode
# (R2 SSE-C disabled) container can lay it down locally BEFORE the initial R2 sync — the
# `--checksum` sync then skips the unchanged seed files and transfers only user deltas.
# Derived in-image from the COMMITTED, freshness-enforced src/lib/agent-seed.generated.ts
# (single source of truth), so this needs no host build ordering and never drifts. Kept
# after expensive runtime dependency/prewarm layers so seed edits retain those caches.
COPY src/lib/agent-seed.generated.ts /opt/codeflare/seed-src/agent-seed.generated.ts
COPY scripts/materialize-agent-seed.mjs /opt/codeflare/seed-src/materialize-agent-seed.mjs
RUN node /opt/codeflare/seed-src/materialize-agent-seed.mjs \
        --seed /opt/codeflare/seed-src/agent-seed.generated.ts \
        --out /opt/codeflare/agent-seed-bake \
    && echo "[Dockerfile] agent-seed bake materialized for default + advanced modes"

# Create workspace directory structure
RUN mkdir -p /app/host

# Copy pre-compiled host server from builder stage
COPY --from=builder /app/host/node_modules /app/host/node_modules
COPY --from=builder /app/host/dist /app/host/dist
COPY host/package.json /app/host/

# Copy entrypoint script
COPY entrypoint.sh /entrypoint.sh
COPY transcript-retention.mjs /transcript-retention.mjs
RUN chmod +x /entrypoint.sh /transcript-retention.mjs && echo "Build timestamp $(date)" > /build-timestamp.txt

# Reset working directory
WORKDIR /

# Expose port 8080: Terminal server (handles WebSocket + health/metrics)
EXPOSE 8080

# Graceful shutdown
STOPSIGNAL SIGINT

# Run as root by design. SAST-false-positive: rclone FUSE mount, runtime tool
# installation (locked agent CLIs), and user workspace access all
# require root throughout the container lifetime, not just during init. The
# security boundary is network isolation via the Durable Object proxy: only
# the DO can reach port 8080, and the per-DO container auth token validates
# every proxied request.
ENTRYPOINT ["/entrypoint.sh"]
