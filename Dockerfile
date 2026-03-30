# Codeflare Container - Multi-session terminal server with rclone sync
# Uses node-pty for PTY management and rclone for R2 storage sync

# ---- Stage 1: Builder (compile native addons + TypeScript) ----
FROM node:24-bookworm-slim@sha256:e8e2e91b1378f83c5b2dd15f0247f34110e2fe895f6ca7719dbb780f929368eb AS builder

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
FROM node:24-bookworm-slim@sha256:e8e2e91b1378f83c5b2dd15f0247f34110e2fe895f6ca7719dbb780f929368eb

# Suppress npm update nag; configure claude-unleashed for non-interactive container use
ENV NPM_CONFIG_UPDATE_NOTIFIER=false
ENV CLAUDE_UNLEASHED_SKIP_CONSENT=1
ENV CLAUDE_UNLEASHED_CHANNEL=stable
ENV DISABLE_INSTALLATION_CHECKS=1
ENV CLAUDE_UNLEASHED_NO_UPDATE=1
ENV IS_SANDBOX=1

# Upgrade base packages + install runtime packages (single apt-get update layer)
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends \
    # System essentials
    ca-certificates \
    bash \
    # ECC continuous learning v2.1 observe hooks
    python3 \
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
    && ln -s "$(which nvim)" /usr/local/bin/vim

# Install rclone (pinned version — unpinned install.sh broke bisync, see documentation/storage-and-sync.md)
RUN curl -fsSL https://downloads.rclone.org/v1.73.2/rclone-v1.73.2-linux-amd64.deb -o /tmp/rclone.deb \
    && echo "2c6bc8e6ee23493907bdae2c599b00b9fcc2def7d1346211ce371323d14ac9d6  /tmp/rclone.deb" | sha256sum -c - \
    && dpkg -i /tmp/rclone.deb \
    && rm /tmp/rclone.deb

# Add GitHub CLI apt repo (key + source list only — actual install is after .cache-bust)
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /tmp/githubcli-archive-keyring.gpg \
    && echo "20e0125d6f6e077a9ad46f03371bc26d90b04939fb95170f5a1905099cc6bcc0  /tmp/githubcli-archive-keyring.gpg" | sha256sum -c - \
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
RUN YAZI_VERSION="26.1.22" && \
    YAZI_SHA256="a136269b2d5fbb5fb43f3fac3391446e8fbc72aba1c4bb4fae6e6d1556420750" && \
    curl -fsSL --retry 3 --retry-delay 5 --connect-timeout 30 "https://github.com/sxyazi/yazi/releases/download/v${YAZI_VERSION}/yazi-x86_64-unknown-linux-gnu.zip" -o /tmp/yazi.zip && \
    echo "${YAZI_SHA256}  /tmp/yazi.zip" | sha256sum -c - && \
    unzip -o /tmp/yazi.zip -d /tmp/yazi && \
    mv /tmp/yazi/yazi-x86_64-unknown-linux-gnu/yazi /usr/local/bin/yazi && \
    chmod +x /usr/local/bin/yazi && \
    rm -rf /tmp/yazi /tmp/yazi.zip
RUN LAZYGIT_VERSION="0.60.0" && \
    LAZYGIT_SHA256="6252ca6cf98bc4fd3e0d927b54225910cfa57b065d0ad88263f14592f7f9ab15" && \
    curl -fsSL --retry 3 --retry-delay 5 --connect-timeout 30 "https://github.com/jesseduffield/lazygit/releases/download/v${LAZYGIT_VERSION}/lazygit_${LAZYGIT_VERSION}_linux_x86_64.tar.gz" -o /tmp/lazygit.tar.gz && \
    echo "${LAZYGIT_SHA256}  /tmp/lazygit.tar.gz" | sha256sum -c - && \
    tar xzf /tmp/lazygit.tar.gz -C /usr/local/bin lazygit && \
    chmod +x /usr/local/bin/lazygit && \
    rm /tmp/lazygit.tar.gz

# Install claude-unleashed globally (wraps Claude Code with permission bypass)
# Users can update manually by running `cu` or `claude-unleashed` in any terminal tab
# (only works when Fast Start is OFF — when ON (default), CLAUDE_UNLEASHED_NO_UPDATE=1 prevents updates)
# .cache-bust is generated by deploy workflow with unique SHA per build
# COPY invalidates this layer so npm resolves fresh "latest" each deploy
COPY .cache-bust /tmp/.cache-bust

# Install gh CLI (after .cache-bust so every deploy gets latest)
RUN apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

RUN npm install -g github:nikolanovoselec/claude-unleashed#999d553c6c395acff8210a252e5a2f39ec10344c && \
    rm -f /tmp/.cache-bust && \
    npm cache clean --force && \
    rm -rf /root/.npm

# Pre-update claude-code to latest and pre-patch for fast container startup.
# This does at build-time what cu normally does on first run:
#   1. npm view + npm install → latest @anthropic-ai/claude-code
#   2. applyPatches() → cli-patched.js + .hash written
#   3. V8 compile cache seeded by importing the patched CLI
# Pass --help so the CLI loads all JS (seeding V8 cache) then exits cleanly.
# Without it, non-interactive Docker build has no TTY/stdin and the CLI errors.
ENV NODE_COMPILE_CACHE=/root/.cache/node-compile-cache
RUN mkdir -p $NODE_COMPILE_CACHE && \
    claude-unleashed --silent --no-consent --help > /dev/null 2>&1 || true

# Install Codex + Gemini + OpenCode + Copilot CLIs for multi-agent support (single RUN for npm dedup).
# OpenCode (opencode-ai) is an open-source multi-model AI coding CLI supporting 75+ providers.
# Consolidated install allows npm to deduplicate shared dependencies across packages.
# OpenCode ships 11 platform binaries as optionalDependencies — delete unused ones (~446MB saved).
# Debian uses glibc — postinstall correctly hard-links opencode-linux-x64 to bin/.opencode.
# Uses @latest — .cache-bust above invalidates this layer so every deploy pulls newest versions
RUN npm install -g @openai/codex@latest @google/gemini-cli@latest opencode-ai@latest @github/copilot@latest && \
    cd /usr/local/lib/node_modules/opencode-ai/node_modules && \
    find . -maxdepth 1 -name 'opencode-*' ! -name 'opencode-linux-x64' -type d -exec rm -rf {} + && \
    npm cache clean --force && \
    rm -rf /tmp/* /root/.npm

# Install MCP memory server for persistent agent memory across sessions
RUN npm install -g @modelcontextprotocol/server-memory && \
    npm cache clean --force && rm -rf /root/.npm

# V8 compile cache warm-up: Pre-populate Node.js V8 compile cache at Docker build time.
# Running --version triggers V8 to compile and cache bytecode for each CLI's JavaScript.
# This speeds up first-launch of Node.js CLIs (codex, gemini, copilot) inside containers
# by avoiding the compilation overhead on every container start.
# Note: Go binaries (like opencode) don't need this — they're already natively compiled.
RUN codex --version 2>&1 || true && \
    gemini --version 2>&1 || true && \
    copilot --version 2>&1

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

# Run as root for rclone mount and tool installation
ENTRYPOINT ["/entrypoint.sh"]
