# Upstream provenance

Vendored from `nextlevelbuilder/ui-ux-pro-max-skill` at commit `97eb2a20032f0833e3d317162208a60385b0f96e`.

License: MIT; see `LICENSE`.

Codeflare adaptation: the skill-local search command uses the canonical Claude preseed path (`~/.claude/skills/ui-ux-pro-max`) so the existing seed generator can rewrite it for each supported runtime. Data, references, and the runtime Python search implementation are retained from upstream. Upstream script tests are omitted from the runtime preseed because CI tests the delivered seed contract rather than shipping upstream development fixtures to every user.
