SilverBullet runtime config. The `.silverbullet/config.yaml` file in
the vault root holds bootstrap settings (indexPage, defaultMode);
this page holds runtime settings federated into SB on first browser
open.

`Library/Std` is SilverBullet's bundled template/widget library - it
provides `widgets.commandButton`, `templates.fullPageItem`,
`tags.page`, `index.contentPages()` and the other primitives the
dashboard ([[Index]]) uses. Without it the dashboard queries fail
silently and break in-page link handlers.

```yaml
libraries:
- import: "[[!silverbullet.md/Library/Std/*]]"

# Hide Codeflare-authoritative preseed pages from the page picker
# and autocomplete. They are still reachable via wikilinks
# ([[Index]], [[README]], etc.) and still indexed by graphify; we
# just don't want them cluttering the user's search surface alongside
# their actual notes. Index is NOT hidden so it remains discoverable
# as the landing page.
pageBlackList:
- "^README$"
- "^CONFIG$"
- "^STYLES$"
```
