# Upstream provenance

Adapted from `vercel-labs/agent-skills` at commit `dd089a8c752c966dee8bf0f27cb625ba193ffd9e`.

License: MIT. The managed runtime carries one shared notice at `skills/_licenses/vercel-agent-skills-MIT.txt`. At the pinned commit, the repository README declares MIT, the React skill frontmatter declares MIT, and the owning build package declares MIT:

- https://github.com/vercel-labs/agent-skills/blob/dd089a8c752c966dee8bf0f27cb625ba193ffd9e/README.md#license
- https://github.com/vercel-labs/agent-skills/blob/dd089a8c752c966dee8bf0f27cb625ba193ffd9e/skills/react-best-practices/SKILL.md
- https://github.com/vercel-labs/agent-skills/blob/dd089a8c752c966dee8bf0f27cb625ba193ffd9e/packages/react-best-practices-build/package.json

Codeflare adaptation: replaced the previous generic frontend cookbook with a compact performance workflow distilled from the upstream React priorities. Retained high-impact guidance for waterfalls, bundles, server ownership, client deduplication, rerenders, rendering, and measured hot paths. Omitted the generated 108 KB guide, 70 individual rule files, build tooling, fixtures, archives, examples, and low-value repetition. Component API composition remains owned by `frontend-components`.
