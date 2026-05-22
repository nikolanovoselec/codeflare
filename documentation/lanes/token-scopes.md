# API Token Scopes

When connecting GitHub and Cloudflare accounts in Codeflare, you create API tokens with specific permissions (scopes). This page documents what each scope does and which tier includes it.

You can adjust scopes anytime from your [GitHub token settings](https://github.com/settings/tokens) or [Cloudflare API tokens dashboard](https://dash.cloudflare.com/profile/api-tokens).

## GitHub Fine-Grained PAT

Codeflare offers three scope tiers. Choose based on your workflow:

- **Minimal** -- just git access
- **Recommended** -- full development workflow (repos, PRs, CI, deploy)
- **Advanced** -- everything, including GitHub Copilot

### Repository Permissions

| Scope | Minimal | Recommended | Advanced | Why |
|---|---|---|---|---|
| Contents: Write | yes | yes | yes | Push/pull code, manage branches and tags |
| Metadata: Read | yes | yes | yes | Basic repo info (always granted) |
| Pull Requests: Write | - | yes | yes | Create, review, and merge pull requests |
| Actions: Read | - | yes | yes (Write) | View CI workflow runs and logs |
| Workflows: Write | - | yes | yes | Create and modify `.github/workflows/` files |
| Administration: Write | - | yes | yes | Create/delete repositories, manage settings |
| Secrets: Write | - | yes | yes | Set GitHub Actions secrets (e.g., deploy credentials) |
| Actions Variables: Write | - | - | yes | Set GitHub Actions variables |
| Issues: Write | - | - | yes | Create and manage issues |
| Deployments: Write | - | - | yes | Manage deployment statuses |
| Environments: Write | - | - | yes | Manage deployment environments and secrets |
| Pages: Write | - | - | yes | Configure GitHub Pages |
| Commit Statuses: Write | - | - | yes | Set commit status checks |
| Webhooks: Write | - | - | yes | Manage repository webhooks |
| Merge Queues: Write | - | - | yes | Manage merge queue entries |
| Security Events: Write | - | - | yes | Access code scanning and security alerts |
| Custom Properties: Write | - | - | yes | Set custom properties on repositories |
| Discussions: Write | - | - | yes | Create and manage discussions |

### Account Permissions

| Scope | Minimal | Recommended | Advanced | Why |
|---|---|---|---|---|
| Emails: Read | - | - | yes | Read email for git identity |
| Copilot Requests: Read | - | - | yes | Required for GitHub Copilot CLI |

### Notes

- **GitHub Copilot** requires the Advanced tier. The `user_copilot_requests: read` account scope is needed for the Copilot CLI to authenticate.
- Fine-grained PATs expire after 90 days by default. You can change the expiration during creation.
- You can scope tokens to specific repositories or all repositories. For a cloud IDE, "All repositories" is typical since you may create new repos from sessions.

## Cloudflare API Token

Codeflare recommends using the **"Edit Cloudflare Workers"** template when creating your Cloudflare API token. This template includes the most common permissions for Workers development.

### What the Template Includes

| Permission | Level | Why |
|---|---|---|
| Workers Scripts | Edit | Deploy and manage Worker code |
| Workers KV Storage | Edit | Create and manage KV namespaces |
| Workers R2 Storage | Edit | Create and manage R2 buckets |
| Workers Routes | Edit | Bind Workers to custom domains |
| Cloudflare Pages | Edit | Deploy and manage Pages projects |
| Containers | Edit | Manage Cloudflare Containers |
| Account Settings | Read | Required by wrangler CLI for account context |

### Additional Scopes You May Need

If your agent asks for additional permissions, you can add them by editing your token in the [Cloudflare dashboard](https://dash.cloudflare.com/profile/api-tokens):

| Permission | Level | When Needed |
|---|---|---|
| D1 | Edit | Creating and managing D1 databases |
| DNS | Edit | Managing DNS records for custom domains |
| Zone | Read | Required alongside DNS for zone resolution |
| Turnstile | Edit | Creating CAPTCHA widgets |
| Access: Apps and Policies | Edit | Managing Cloudflare Access applications |
| Access: Organizations | Edit | Managing Access groups and identity providers |
| API Tokens | Edit | Managing other API tokens programmatically |

### Notes

- The "Edit Cloudflare Workers" template covers most use cases out of the box.
- Your agent will tell you if it needs additional scopes during a session.
- Cloudflare API tokens do not expire by default but can be set to expire during creation.
- You can scope tokens to specific accounts and zones, or use "All accounts" and "All zones" for convenience.
