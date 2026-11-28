---
name: ship
description: Guide a first-time builder from an idea to requirements, a polished project, a private GitHub repository, and an optional verified Cloudflare deployment. Also use to publish, push, share, or deploy an existing project without repeating completed setup.
version: 2.0.0
---

# Ship: From Idea to Live URL

Speak plainly. Tell the user what is ready, what happens next, and what (if anything) only they can do. Inspect the project and its rules, remotes, workflows, and deployment config first. Reuse working setup; don't ask for facts you can verify or make the user run routine commands. Use native shell tools, not context-mode. Never run local test suites; use the project's approved local checks and CI.

Follow the phases in order; skip completed work and phases outside the requested delivery. Resume at the first unfinished phase, not at the first question.

## Phase 1: Agree on the brief

Use the structured questionnaire for unresolved decisions. In Pi, activate `ask_user_question` by exact name through `capability` if hidden; in Claude use `AskUserQuestion`. Inspect the live schema. Ask up to four plain-language questions per batch, with two to four distinct options each. Put one grounded recommendation first, label it `(Recommended)`, and explain why. Use the tool's built-in custom answer; don't add an “Other” option. If a runtime has no questionnaire, state that and offer the same concise choices in chat. A timeout, cancellation or error is not a manual answer and cannot supply authorization for a protected action.

- **Project name:** Ask “What should we call your project?” for a new unnamed project. Recommend a natural name based on the brief and invite a custom name. If none is supplied, infer a name from the agreed requirements; do not ask again. Keep the display name separate from its lowercase, hyphenated repository slug.
- **Requirements:** For a new build or material gaps, guide the user through who it is for, what they need to accomplish, and the smallest useful first release. Ask about saved data, sign-in or public access only when they change what you build or expose. Recommend a concrete first slice instead of asking users to choose frameworks or services. Skip decisions already answered.
- **Delivery:** Distinguish keeping work local, pushing it to private GitHub, and deploying it to an audience. A private repository does not make the deployed app private. Confirm a compact brief and the delivery scope when unresolved; don't re-confirm choices the user already made. Missing authorization stops the affected action, not independent preparation.

If there is no code and the user asked to build, use `cloudflare-stack` for an uncommitted technology choice and carry forward the agreed brief and delivery scope. Don't repeat the interview or ask again whether to publish. Honor the existing stack or an explicit user choice. Build the agreed first version and verify its key behaviors. If they only asked to ship an empty project, explain that there's nothing to push yet and offer the smallest starting point. Clone an existing repo only if that's the user's selected project; run the clone in the foreground with visible progress and no timeout.

**Ready for Phase 2:** You have a project name, first-release brief, and delivery scope. Keep local-only work local.

## Phase 2: Choose the website address

For a website the user wants deployed on Cloudflare, use their connected Cloudflare integration before asking where to publish. Follow `deploy-credentials` to resolve the live management account; never use the Browser Run account as a guess. Use the configured managed API path to read [Cloudflare zones](https://developers.cloudflare.com/api/resources/zones/methods/list/) (`GET /client/v4/zones`), following pagination and scoping results to the selected account and active zones. If several accounts are plausible, ask which one to use. Show domain names, not credential values. Do not mistake missing permissions or failed lookup for “no domains.”

1. Ask **“Which domain should the site use?”** in the questionnaire. Offer live eligible domains and recommend one that fits the brief. If there are more than fit the tool's option limit, offer to see more; validate a custom answer against the live list. If no custom domain is usable, explain why and offer to resolve access or explicitly choose the Cloudflare `workers.dev` address where supported. Do not switch destinations silently.
2. Ask **“What should go before `<domain>`?”** Recommend a free subdomain derived from the project slug, show the full address, and allow a custom choice. Validate a single DNS label (letters, digits and hyphens; no leading or trailing hyphen), join it to the selected domain, and check the exact hostname for conflicting DNS records, routes or domain bindings. Reuse only a verified mapping to this project. If occupied by another service or unverifiable, do not overwrite it; offer another checked subdomain.
3. Put the full hostname and intended audience in the questionnaire before deployment. An explicit choice authorizing deployment to that address is enough; do not ask again unless the target changes. A guessed, timed-out or skipped choice cannot authorize hostname or DNS changes. Preserve an already approved hostname; do not ask twice.

**Ready for Phase 3:** The website has an authorized destination, or deployment is explicitly pending. Naming, building and an authorized private push may continue while the destination is pending.

## Phase 3: Build and check the project

For new or changed UI, load the Codeflare `design` router and the platform owner it selects (for web, `frontend-design`). Use the project's design system, components, and tokens where they exist; otherwise establish a small, coherent design system around the user's audience, content and primary action. Codeflare's design workflow guides the work; don't stamp Codeflare branding or generic templates onto the user's product. Implement real content and controls, relevant empty/error states, accessible keyboard interactions, and responsive layouts. Don't add UI to backend-only work or redesign an existing app just to publish it.

Once the direction is in place and the UI is implemented, use installed `impeccable` for critique and scoped polish before declaring it ready. Check the rendered primary flow on phone and desktop where an authorized browser is available. Fix concrete hierarchy, readability, interaction and accessibility issues, not just colors or decoration. If the design or Impeccable skill isn't available in this mode, follow the existing design or the agreed brief, and perform the scoped checks you can; say which specialist or visual checks couldn't run. Don't install a replacement or claim a pass without evidence.

If a push will trigger deployment, prepare the approved target's config and CI before that push using Phase 5's deployment checks. Do not push a config that would publish to the wrong target or expose a private site.

**Ready for Phase 4:** The agreed first release is implemented and its key behavior is verified, or any missing verification is reported. Do not describe unverified work as ready to deploy.

## Phase 4: Push to private GitHub

Do this only when the user authorized GitHub publication. Use the selected repository and branch if there is already an authorized remote; don't change its visibility or overwrite unrelated work. For a new remote, use the managed GitHub connection and verify the actual owner before creating anything. If access is missing, load `deploy-credentials` and follow the supported connection flow. Do not request secrets in chat or ask for delete permissions to publish. Use HTTPS and the user's GitHub noreply Git identity for new configuration; preserve existing valid settings.

1. **Write the README.** Create or improve `README.md` before the first push. Lead with the chosen project name, what it does, and who it's for. Include the implemented features, actual setup/run and test commands, and deployment instructions when applicable. Link the live URL only once verified. Preserve useful existing instructions and licenses; don't invent badges, screenshots, features, or public links. Keep it concise and professional.
2. **Prepare the commit.** If the project is not tracked yet, initialize Git in its own directory on `main`; do not reinitialize an existing repository. Stage only the intended files. Review the staged diff for secrets, private data, build artifacts, and unrelated changes; use project-level ignore rules where needed. Never push exposed data or work you are not authorized to share. Commit the intended changes and honor branch protection and the project's review workflow.
3. **Create privately and handle collisions.** Validate the owner and slug as GitHub names, then create the new repository with `--private` (for example, `gh repo create "$owner/$slug" --private --source=. --remote=origin` from the project directory when `origin` is unused). If GitHub confirms the owner/name is already taken, do not use or alter that repo. Pick a related available slug yourself (for example `field-notes-web`, then `field-notes-web-2`) and try the distinct name without asking the user to rename it. Keep collision retries bounded. Keep the original display name. Do not treat permissions, validation, network errors or an uncertain result as collisions; verify the exact owner/name and any creation result before trying another name. Confirm the new remote points to the intended repository and is private before pushing.
4. **Push and verify.** Inspect which workflows a push would trigger before pushing, especially on an existing remote; do not trigger a deployment outside the authorized scope. Verify the remote branch contains the intended commit. If the user wanted a private backup or GitHub only, report the repository link and stop.

**Ready for Phase 5:** The intended commit is on the verified remote and deployment is authorized. For a new repository, confirm it is private. GitHub-only requests end here.

## Phase 5: Deploy the agreed release

Keep the existing hosting target and deployment path. For a Cloudflare Workers project, use `deploy-credentials` to resolve the selected management account and the supported access path. The presence of a token variable or secret name doesn't prove it works; a managed placeholder is not a secret to copy into GitHub Actions. Reuse working CI credentials. If secrets or additional permissions are genuinely required, explain what is needed and use the supported secure setup for the confirmed repo/account. Never read, print, or paste secrets in chat. Obtain explicit authorization for credential changes, production, billing, user data, and destructive actions.

- Reuse the repository's Wrangler config and CI. For a new Workers setup, consult [Wrangler templates](references/wrangler-templates.md) and [workflow templates](references/workflow-templates.md). Adapt to the actual branch, package manager, entry point, tests and assets. Do not publish the repo root as static assets. Keep pinned project tooling; for new tooling use the latest compatible stable release from its authoritative source. Don't switch a working workflow just to use the template.
- For the website address chosen in Phase 2, wire that exact hostname into the existing deployment configuration. If this Worker is the origin, use a [Workers Custom Domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) with `custom_domain: true` in the target Wrangler route; preserve other routes and bindings. Keep existing hosting for sites using a different Cloudflare product, following its official custom-domain workflow. Recheck hostname ownership and conflicts before triggering deploy, including a push that triggers it. Use the approved deployment path to attach the hostname automatically; Cloudflare manages DNS and TLS for a Workers Custom Domain. Do not add a separate DNS record, enable takeover options, or confirm replacement of unrelated routing. A missing write grant is a specific blocker, not permission to switch targets or ask for broad credentials.
- Only set up bindings the code needs. Verify exact resource/account identities before reusing D1, R2 or KV. Provision only authorized resources, and apply required D1 migrations once through the project's migration path, not both locally and in CI. Use the declared Durable Object migrations; do not create separate resources for them.
- Keep required checks before deployment. Run real tests through CI; never remove a failing real test to get a green run. Match the check and deployment runs to the intended workflow, branch and commit, not the latest run in the repo. Use background monitoring and report inconclusive or failed results plainly. Do not force promotion or replay an uncertain mutation.
If config or code changes after the initial push, verify the new remote commit and re-run its required checks before treating it as the release. Do not dispatch a second deployment when the approved push already started one.

**Ready for Phase 6:** Exact-revision deployment succeeds for the approved target. A queued run, pending DNS or TLS, or an unconfirmed domain association is not a live result.

## Phase 6: Verify and hand off

Get the actual URL and release identity from deployment evidence. For a custom domain, verify it is bound to the intended release and check the exact HTTPS hostname, not just the `workers.dev` fallback. Check the main behavior as the intended audience; a workflow success alone is not a live check. Return the private GitHub link, the verified live URL (if any), and a short note on what was checked or remains pending. Don't claim public access or automatic future deployment unless confirmed.

## Cleanup is separate

An instruction to take a site offline is not permission to delete its GitHub repo, local files or bound data. If asked to clean up, identify the selected Worker, repo, local checkout and resources separately. Explain the impact, require explicit authorization for the exact destructive actions, and verify each result. Never infer deletion authority from a questionnaire default or a publishing request.
