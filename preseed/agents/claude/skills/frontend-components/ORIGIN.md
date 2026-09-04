# Upstream provenance

Codeflare-owned guidance extended from `vercel-labs/agent-skills` at commit `dd089a8c752c966dee8bf0f27cb625ba193ffd9e`.

License: MIT. The managed runtime carries one shared notice at `skills/_licenses/vercel-agent-skills-MIT.txt`; the pinned commit and source URLs below record upstream evidence.

Selected upstream composition sources:

- https://github.com/vercel-labs/agent-skills/blob/dd089a8c752c966dee8bf0f27cb625ba193ffd9e/skills/composition-patterns/rules/architecture-avoid-boolean-props.md
- https://github.com/vercel-labs/agent-skills/blob/dd089a8c752c966dee8bf0f27cb625ba193ffd9e/skills/composition-patterns/rules/architecture-compound-components.md
- https://github.com/vercel-labs/agent-skills/blob/dd089a8c752c966dee8bf0f27cb625ba193ffd9e/skills/composition-patterns/rules/patterns-children-over-render-props.md
- https://github.com/vercel-labs/agent-skills/blob/dd089a8c752c966dee8bf0f27cb625ba193ffd9e/skills/composition-patterns/rules/patterns-explicit-variants.md
- https://github.com/vercel-labs/agent-skills/blob/dd089a8c752c966dee8bf0f27cb625ba193ffd9e/skills/composition-patterns/rules/state-context-interface.md
- https://github.com/vercel-labs/agent-skills/blob/dd089a8c752c966dee8bf0f27cb625ba193ffd9e/skills/composition-patterns/rules/state-decouple-implementation.md
- https://github.com/vercel-labs/agent-skills/blob/dd089a8c752c966dee8bf0f27cb625ba193ffd9e/skills/composition-patterns/rules/state-lift-state.md

Codeflare adaptation: folded only explicit variants, children and slots, compound components, bounded state ownership, and provider-interface guidance into the existing skill. Component extraction follows ownership, coupling, state, reuse, testability, and maintenance evidence rather than a repetition threshold. The adaptation retains central content/style ownership, immutable refactors, accessibility, and behavioral-test boundaries while omitting the separate upstream skill, generated guide, individual rule files, examples, metadata, templates, and build tooling.
