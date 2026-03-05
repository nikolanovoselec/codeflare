---
name: ship
description: This skill should be used when the user wants to "ship this", "deploy this", "publish my code", "push to GitHub", "create a repo", "set up GitHub", "share my code", "put this online", "make this live", "get a URL for this", "host this", "I want people to see this", "deploy to Cloudflare", "how do I get this on the internet", "I want to share what I built", "make this accessible", "launch this", "push my changes", "create a repository", "set up version control", or mentions anything about getting their code online, shared, deployed, or published. This skill detects the current state of GitHub and Cloudflare configuration and only guides through what is missing. Use this skill proactively — if the user has finished building something and expresses any desire to share it, back it up, deploy it, or make it accessible, this is the right skill.
version: 2.0.0
---

# Ship: From Code to Live URL

An interactive, state-aware skill that guides users from zero to a live URL — detecting what is already set up and skipping completed steps. Combines GitHub setup (Phase 1) with Cloudflare Workers deployment (Phase 2).

## Target Audience

Non-technical users who may have never used GitHub, git, a terminal, or deployed anything before. Every instruction must be explained in plain, jargon-free language. When technical terms are unavoidable, define them inline.

## Important: No Local Test Execution

This environment has limited resources (1 CPU core). Never run `npm test` or any test suite locally. Tests only run in GitHub Actions CI, where the runner has dedicated resources. When creating CI workflows, include a test step only if the project has real tests configured.

## Workflow

On invocation, run through each step below in order. For each step, **detect the current state first** — if the step is already complete, confirm it and move on. Never redo completed steps.

---

## Phase 1: GitHub Setup

### Step 1: Verify Project Exists

Check if the workspace has any meaningful files (not just hidden files or empty directories).

**If the workspace is empty or has no code:** Do not proceed. Instead, ask the user what they want to build. Use questions to understand their goal:
- "What would you like to create? A website, an app, a tool?"
- "Do you already have code somewhere, or are we starting from scratch?"
- "Do you have an existing GitHub repository you want to clone?"

If they have an existing repo, clone it with `gh repo clone <url> ~/workspace/<name>`. If they want to start from scratch, help them describe their idea and build it first (the `/cloudflare-stack` skill ensures the right tech stack). Return to `/ship` when they have code ready.

### Step 2: Authenticate with GitHub

Run `gh auth status` to check if already logged in.

**If authenticated:** Confirm which account is connected. Then check git identity (`git config --global user.name` and `git config --global user.email`). If both are set, move to Step 3.

**If not authenticated:**

1. Explain: "GitHub is where your code will live online — think of it as cloud storage for your project, with built-in tools to automatically deploy it."
2. Ask if the user already has a GitHub account. If not, tell them to go to https://github.com/signup in their browser and create one — it is free. Wait for confirmation.
3. Run: `BROWSER="" gh auth login --hostname github.com --git-protocol https --web -s user:email,workflow,delete_repo`
   - Tell them: "A code and a link will appear. Open the link in a new tab in your browser, paste the code, and approve the connection."
   - Explain what they see in the terminal (URL + one-time code).
   - If it fails, explain simply and retry.
   - Verify with `gh auth status`.

**Important:** Always use `BROWSER=""` (prevents browser launch attempts in containers). Always use `--web` (skips the interactive auth method prompt that would hang in the Bash tool). Always use `--git-protocol https` (no SSH keys available). Always use `-s user:email,workflow,delete_repo` (needed for: email retrieval for git identity, pushing `.github/workflows/` files, and deleting repos if needed). Request all scopes upfront so the user only has to authenticate once.

**Set git defaults:**

Run `git config --global init.defaultBranch main` to ensure new repos use `main` as the default branch (CI workflows trigger on `main`).

**Set git identity if missing:**

1. Explain: "Git needs to know your name and email to label your work — like signing your name on a document."
2. Get name: `gh api user --jq '.name'`
3. Get the GitHub username: `gh api user --jq '.login'`. Use the noreply email format: `<username>@users.noreply.github.com`. This protects the user's private email from appearing in public commits.
4. Set: `git config --global user.name "Name"` and `git config --global user.email "<username>@users.noreply.github.com"`.
5. Confirm what was set.

**Important:** Never use the user's real email for git commits. Always use the `<username>@users.noreply.github.com` format. This keeps their personal email private while still linking commits to their GitHub account.

### Step 3: Create Repository

Check if the current working directory already has a git repo with a remote.

**If a repo with a remote exists:** Confirm and move to Step 4.

**If a local git repo exists but has no remote:**

1. Explain: "Your project is tracked locally but not connected to GitHub yet. Let me connect it."
2. Verify a `.gitignore` exists. If not, create one appropriate for the project type. A global gitignore at `~/.gitignore_global` already excludes dangerous files (secrets, `.env`, `.wrangler/`, `.dev.vars`, `*.pem`, `*.key`, `node_modules/`), but a project-level `.gitignore` is also good practice.
3. Run: `gh repo create <name> --public --source=. --remote=origin --push`
4. If it fails because the name is taken, tell the user and ask for a different name or suggest appending a number (e.g., `my-app-2`). Retry.
5. Confirm the repo URL.

**If no git repo exists:**

1. Ask the user what they want to call their project. Suggest a name based on the directory name.
2. `git init`
3. Create a `.gitignore` appropriate for the project type. Global gitignore covers dangerous files, but add project-specific exclusions.
4. Before staging, check for sensitive files that might slip past gitignore (`.env`, `.dev.vars`, `*.pem`, `*.key`, `credentials*`, `*secret*`). If found, add them to `.gitignore` first.
5. Stage and create an initial commit: `git add -A && git commit -m "Initial commit"` (needed before `gh repo create --push` can work).
6. Run: `gh repo create <name> --public --source=. --remote=origin --push`
7. If it fails because the name is taken, ask for a different name. Retry.
8. Confirm the repo URL.

### Step 4: Create CI Workflow

Check if `.github/workflows/` exists and contains a workflow.

**If a workflow exists:** Confirm and move to Step 5.

**If no workflow exists:**

1. Explain: "GitHub Actions is like an assistant that automatically checks your code every time you push changes. Let me set that up."
2. Detect the project type:
   - If `package.json` exists, check the `test` script value. If it exists AND does NOT contain "no test specified" or just "exit 1" → use the Node.js CI template with tests
   - If `package.json` exists but has no real test script → use the Node.js CI template without tests
   - If only HTML/CSS/JS files (no `package.json`) → use the minimal CI template (checkout only)
3. Create `.github/workflows/ci.yml`. Read `references/workflow-templates.md` for templates.
4. Explain: "This will automatically check your code every time you push an update."

### Step 5: Commit and Push

Check if there are uncommitted changes.

**If working tree is clean and remote is up to date:** Confirm and move to Step 6.

**If there are changes to commit:**

1. Review what will be staged. Check for sensitive files that might have slipped past `.gitignore` (`.env`, `.dev.vars`, `*.pem`, `*.key`, `credentials*`, `*secret*`). If found, warn the user and add them to `.gitignore` first.
2. `git add -A`
3. Create a relevant commit message. For initial commits, "Initial commit" is fine. For subsequent pushes, describe what changed (e.g., "Add contact form", "Fix header styling").
4. `git push -u origin HEAD`
5. Confirm success.

### Step 6: Verify GitHub Setup

1. Run `gh run list --limit 1` to check if a workflow ran.
2. If a run exists: "Your code is now on GitHub and the automated pipeline ran. You can see your project at https://github.com/<user>/<repo>."
3. If no run: just confirm the code is on GitHub.

**Determine whether to continue to Phase 2:**

Check the user's original request:
- If they only asked to "push to GitHub", "create a repo", "publish", or "back up my code" → Stop here. Tell them: "Your code is on GitHub! When you want to make it available on the internet with a live URL, just tell me to ship it or deploy it."
- If they asked to "deploy", "ship", "go live", "put online", "get a URL", "host", or anything about making it accessible on the internet → Continue to Phase 2.

---

## Phase 2: Cloudflare Workers Deployment

### Step 7: Check Project Compatibility

Cloudflare Workers supports JavaScript, TypeScript, WebAssembly, and static sites (HTML/CSS/JS).

- If `package.json` exists → compatible
- If only HTML/CSS/JS files → compatible (static site, will use Workers Assets)
- If `wrangler.toml` already exists → compatible
- If the project uses Python, Go, Ruby, Java, or another non-JS/TS server-side language → **not compatible**. Explain: "Cloudflare Workers runs JavaScript, TypeScript, and WebAssembly. Your project uses [language], which cannot run on Workers. You could rebuild it in JavaScript/TypeScript, or look into a different hosting provider." Do not proceed.

### Step 8: Check Existing Cloudflare Configuration

Look for existing Cloudflare setup:
- `gh secret list` — check for `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`
- Check if `wrangler.toml` exists

**If both secrets exist and wrangler.toml exists:** Skip to Step 12 (push and deploy).

**If partially configured:** Skip only the completed parts.

### Step 9: Cloudflare Account and Credentials

Ask the user: "Do you already have a Cloudflare account?"

**If no:**
1. Explain: "Cloudflare is where your project will run on the internet. It is free for what we need."
2. Tell them to go to https://dash.cloudflare.com/sign-up and create an account.
3. Warn them: "After signing up, Cloudflare might ask you to 'add a site' or enter a domain name. You can skip that — we do not need a domain. Just close that page or click on the Cloudflare logo to go to your dashboard."
4. Wait for confirmation.

**Get the API Token:**

1. Explain: "We need to create a special key that lets GitHub deploy to your Cloudflare account. This key can only do deployments — nothing else — so it is safe."
2. Tell them to go to https://dash.cloudflare.com/profile/api-tokens
3. Walk them through step by step:
   - "Click the blue 'Create Token' button."
   - "Find the template called 'Edit Cloudflare Workers' and click 'Use template'."
   - "On the next page, select your account from the 'Account Resources' dropdown."
   - "You will see a 'Zone Resources' section — delete all the zone rows by clicking the X next to each one. We do not need zone permissions for deploying to workers.dev."
   - "You should only have Account-level permissions left: 'Cloudflare Workers Scripts: Edit' and 'Account Settings: Read'."
   - "Click 'Continue to summary'."
   - "Click 'Create Token'."
   - "Copy the token now — this is the only time you will see it. Do NOT paste it into this chat."

**Get the Account ID:**

1. Tell them to go to https://dash.cloudflare.com
2. "Next to your account name, click the three dots '...' menu and select 'Copy Account ID' at the bottom."

### Step 10: Store Credentials as GitHub Secrets

Explain: "We are going to store your Cloudflare credentials securely in GitHub. They will never be visible in your code — GitHub encrypts them."

**Important:** Make sure the current working directory is the project's git directory before running these commands.

**Give the user two options for storing secrets:**

**Option A: Paste commands in the terminal tab (recommended — more secure):**

Tell the user to open a second terminal tab (the "+" button next to the current tab) and paste these two commands one at a time:

1. "Open a new terminal tab above. Paste this command, then paste your API token when prompted and press Enter:"
   ```
   gh secret set CLOUDFLARE_API_TOKEN
   ```
2. "Now paste this command, then paste your Account ID and press Enter:"
   ```
   gh secret set CLOUDFLARE_ACCOUNT_ID
   ```
3. "Come back here and tell me when you are done."

Verify the secrets were set: `gh secret list` — both `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` should appear.

**Option B: Paste secrets in chat (quick, but insecure — not recommended):**

Warn the user: "You can paste the secrets here and I will store them immediately. But be aware: anything you paste in this chat could be stored in conversation history. If you use this method, you should rotate (delete and re-create) your Cloudflare API token after you are done testing, to be safe."

If the user chooses this:
1. Ask for the **API Token**: `printf '%s' "THE_TOKEN" | gh secret set CLOUDFLARE_API_TOKEN`
2. Ask for the **Account ID**: `printf '%s' "THE_ACCOUNT_ID" | gh secret set CLOUDFLARE_ACCOUNT_ID`
3. Confirm both are stored.
4. Tell them: "Important: since your token was pasted in this chat, you should rotate or delete it once you are done testing. Go to https://dash.cloudflare.com/profile/api-tokens, delete the old token, and create a new one using the same steps. Then update the secret with the new token in a terminal tab."

**Security notes:**
- Use `printf '%s'` (not `echo`) to avoid newline issues and shell interpretation.
- Never log or redisplay the token value after receiving it.
- The values are encrypted by GitHub the moment they are stored — they cannot be read back, only overwritten.

### Step 11: Configure Workers

**Check if `wrangler.toml` exists:**

**If it exists:** Verify `name` matches the project and the config looks correct. Move on.

**If not:**

1. Explain: "Cloudflare Workers needs a small configuration file. Let me create one."
2. Determine project type:
   - If `src/index.ts` or `src/index.js` exists, or `package.json` has a `main` field → Workers project
   - If only HTML/CSS/JS files → static site. Use Workers Assets with `[assets] directory = "./public"`. If HTML files are in the root, move them to `public/` first. **Never use `directory = "./"` — it would expose config files publicly.**
3. Create `wrangler.toml` from `references/wrangler-templates.md`. **Replace `my-project` with the actual project name** (repo name or directory name, lowercased and hyphenated). Set `compatibility_date` to the first of the current month.
4. If it is a Workers project and the entry file does not exist, create a minimal worker entry point from the templates.

**Check if the workflow has a deploy step:**

Look at `.github/workflows/ci.yml` for `cloudflare/wrangler-action`.

- **If deploy step exists:** Move to Step 12.
- **If CI workflow exists but no deploy step:** Add the deploy step to the existing `ci.yml`. Rename the workflow from "CI" to "CI & Deploy". Add after any existing steps:

```yaml
      - name: Deploy to Cloudflare Workers
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

- **If no workflow exists:** Create `.github/workflows/ci.yml` using the deploy workflow template from `references/wrangler-templates.md`.

### Step 12: Push and Deploy

1. Check for sensitive files before staging. If found, add to `.gitignore`.
2. `git add -A`
3. Create a relevant commit message (e.g., "Add Cloudflare deployment", "Configure Workers deployment").
4. `git push`
5. Tell the user: "Your code is being deployed. Let me check..."
6. Get the run ID: `RUN_ID=$(gh run list --limit 1 --json databaseId --jq '.[0].databaseId')`
7. Poll until complete (do NOT use `gh run watch` — it can exceed the Bash timeout): `gh run view $RUN_ID --json status,conclusion --jq '[.status, .conclusion] | join(" ")'`. Check every 15 seconds until status is `completed`. Use `run_in_background` for the polling loop if needed.

### Step 13: Verify and Celebrate

1. When the workflow completes, get the run logs: `gh run view $RUN_ID --log` — look for the `.workers.dev` URL that wrangler prints on successful deploy.
2. **If the URL is not found in logs:** Construct it from the `name` field in `wrangler.toml`: `https://<name>.<account-subdomain>.workers.dev`. If still unsure, tell the user to check their Cloudflare dashboard under Workers & Pages.
3. Tell the user: "Your project is live! Anyone can visit it at: <URL>"
4. Tell them: "From now on, every time you want to update your live site, just tell me to push your changes. The deployment happens automatically."

**If the workflow failed:**

1. Check: `gh run view $RUN_ID --log-failed`
2. Explain what went wrong simply.
3. Common failures:
   - **Permission/auth error:** Wrong API token template. Walk user through creating a new token with "Edit Cloudflare Workers" template. Re-store in GitHub secrets.
   - **Workers TOS not accepted:** First-time Workers users may need to visit https://dash.cloudflare.com/ → "Workers & Pages" and accept the terms of service before deployments work. Tell the user: "Open your Cloudflare dashboard, click 'Workers & Pages', and accept any terms that appear. Then I will retry the deployment."
   - **Script/Worker not found:** Check `wrangler.toml` points to the correct entry file.
   - **Test failure:** Check if test script is the default placeholder. If so, remove the test step from the workflow.
4. Fix and push again.

---

## Cleanup: Delete Project

If the user wants to delete their project, remove everything: "delete this project", "take it down", "remove my site", "nuke it".

### Step 1: Confirm

Ask the user: "This will delete your live site, the GitHub repository, and the local files. Are you sure?" Wait for confirmation.

### Step 2: Delete the Cloudflare Worker

**Option A: Dashboard (easiest):**
Tell the user: "Go to your Cloudflare dashboard → Workers & Pages → click on '<project-name>' → Settings → scroll to the bottom → click 'Delete'. Tell me when it is done."

**Option B: Terminal tab (if user has their API token handy):**
Tell the user to open a second terminal tab and run:
```
CLOUDFLARE_API_TOKEN="<their-token>" CLOUDFLARE_ACCOUNT_ID="<their-account-id>" npx wrangler delete <project-name> --force
```
Get the account ID from `wrangler.toml` if available.

Confirm: "Your site has been taken offline."

### Step 3: Delete the GitHub Repository

Run: `gh repo delete <owner>/<repo> --yes`

If this fails with a permission error, the `delete_repo` scope may be missing. Run `BROWSER="" gh auth refresh -h github.com -s delete_repo` to add it, then retry.

Confirm: "GitHub repository deleted."

### Step 4: Delete Local Files

Run: `rm -rf ~/workspace/<project-directory>`

Confirm: "All cleaned up. The project is completely gone."

---

## Communication Style

- Use short sentences. One idea per sentence.
- Celebrate small wins: "Done! GitHub is connected.", "Almost there!", "Your site is live!"
- The moment the user has a working URL is the big moment — make it feel like one.
- If something fails, explain simply and fix it. Never blame the user.
- Never ask the user to type commands — do everything for them and explain what happened.
- When asking the user to do something in their browser, be extremely specific about what to click and what they will see.

## Additional Resources

### Reference Files

- **`references/workflow-templates.md`** — CI and deploy workflow YAML templates
- **`references/wrangler-templates.md`** — wrangler.toml templates and Worker entry points
