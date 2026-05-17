SilverBullet runtime config. The `.silverbullet/config.yaml` file in
the vault root holds bootstrap settings (indexPage, defaultMode);
this page holds runtime settings federated into SB on first browser
open.

`Library/Std` is SilverBullet's bundled template/widget library - it
provides `widgets.commandButton`, `templates.fullPageItem`,
`tags.page`, `index.contentPages()` and the other primitives the
dashboard ([[index]]) uses. Without it the dashboard queries fail
silently and break in-page link handlers.

```yaml
libraries:
- import: "[[!silverbullet.md/Library/Std/*]]"
```
