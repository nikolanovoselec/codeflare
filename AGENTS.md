# Codeflare repository instructions

## Cross-repository ownership

Keep public product behavior, architecture, requirements, source-owned defaults, and REQ/ADR backlinks in this repository.

A task that reads or changes a non-default deployment secret, variable, operator token-permission matrix, GitHub Environment, customer-account prerequisite, provider registration, promotion check, migration procedure, or rollback runbook also owns an update in the private operator repository. If it is unavailable locally, clone it with:

```bash
gh repo clone nikolanovoselec/codeflare-private
```

Read its [documentation contract](https://github.com/nikolanovoselec/codeflare-private/blob/main/docs/governance/documentation-contract.md), update the owning document, and deliver that repository through its own review history. Never copy real credentials, customer identifiers, or private operational values into this public repository.

Deployment-managed skills, rules, hooks, agents, scripts, plugins, and company extension requirements belong to `nikolanovoselec/codeflare-curation`. `preseed/agents/**` here is only the image-baked fallback. Compiler, transform, seed ABI, and Pi runtime-lock changes land here first, then curation advances its compiler pin.

See [public/private documentation boundary](documentation/README.md#publicprivate-documentation-boundary) for full routing.
