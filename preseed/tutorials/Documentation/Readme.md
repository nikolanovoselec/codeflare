# Codeflare

Codeflare is an agentic engineering workspace that runs in your browser. Give it a repository and an objective. The agent investigates, plans, changes code, proves behavior, follows review and CI, and records durable context for later sessions. A patch without evidence is unfinished work.

Each session runs in an isolated Linux container with root access, a real filesystem, terminal tabs, Browser VS Code, GitHub tooling, and the project’s own toolchain. Nothing needs to be installed on your laptop. The container is disposable. Work you push to Git and files included in synchronization are not.

## Start here

Create a session, open it, and ask:

> What can you do?

The agent will explain the complete workspace and offer focused deep dives. Pick the part relevant to your job, or give it the objective immediately. A useful first task sounds like this:

> Clone my repository, inspect its project rules, trace the failing behavior, write the failing behavioral test, and make the smallest correction. Stop before deployment.

That is enough to begin. Configuration tourism can wait until a real task needs it.

## Agents

Pi is the primary agent for Enterprise deployments. Every Enterprise session runs in advanced mode with the full Codeflare capability scope. Other supported runtimes remain selectable when enabled by administrators, with shared policy and portable skills projected where compatible. Commands, tools, and editor integrations follow each runtime’s native capabilities.

Bash remains available when you want a plain terminal without an agent.

## What persists

Git owns committed source history. Included files synchronize to your private storage on a schedule, during a bounded final stop sync, or when you use **Sync now**. Workspace synchronization follows your configured policy and is disabled by default, so push source changes you cannot afford to lose.

The Storage browser lets you browse, upload, download, preview, and delete durable files without starting a container. Vault, Uploads, Temporary, and Workspace appear as familiar folders rather than storage API object keys. Good. Nobody should need to think in object keys before breakfast.

Codeflare’s memory subsystem continuously persists decisions, corrections, observations, debugging discoveries, and source references in the Vault. These captures join the cumulative knowledge graph as permanently queryable content, unless you remove them. I retrieve that history automatically in future sessions and connect it to current requirements, incidents, plans, and code.

Processes, sockets, unsynchronized files, editor databases, and terminal memory remain temporary. Destroying a container also cannot undo a Git push, deployment, migration, API call, or synchronized file that already happened.

## What the agent handles

The agent works across implementation, debugging, Spec-Driven Development, Test-Driven Development, design, documentation, pull requests, CI, and approved releases. It can coordinate specialist reviewers and monitor long-running work without turning every task into a committee meeting.

Graphify connects supported repository structure with durable Vault knowledge. Todo tracks executable work and dependencies. Browser Run handles public research and explicitly authorized rendered verification. Browser VS Code gives you the normal editor, source control, diffs, search, extensions, and integrated terminals when a terminal-only workflow becomes needlessly painful.

## Enterprise credential boundary

In Enterprise deployments, supported GitHub and provider credentials remain outside the container. Codeflare injects them at Worker-side boundaries only for validated requests to approved destinations. Deployment credentials never enter session containers.

The container receives non-secret placeholders for supported intercepted services. Terminal tools still work, but the reusable credential remains outside the workload. Cloudflare Access protects Enterprise ingress and binds each session to the authenticated user.

To inspect the GitHub placeholder safely, open a Bash tab after connecting GitHub and run:

```bash
if [ "${GH_TOKEN-}" = "codeflare-enterprise" ]; then
  printf 'GH_TOKEN=%s\n' "$GH_TOKEN"
else
  printf '%s\n' 'Enterprise GitHub placeholder is unavailable. No value printed.'
fi
```

Only after you see `GH_TOKEN=codeflare-enterprise`, verify boundary authorization:

```bash
gh api user --jq '{login, id}'
```

## Where to go next

- **Getting Started** gives you one short first-session path.
- **Toolchain** walks through GitHub Actions and a Cloudflare Workers deployment for your own project.
- **Examples** contains complete starter specifications at three levels of scope.

Start with a real objective. The workspace makes more sense while it is doing work.
