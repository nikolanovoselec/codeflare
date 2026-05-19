# Vault

`/home/user/Vault/` is the persistent user-curatable note store, synced session-to-session via rclone bisync.

**Trigger:** any tool call inside `/home/user/Vault/`, any user prompt referencing vault contents, any background hook for vault-monitor.

**Route:** invoke the `vault-operations` skill for layout, who-writes-where rules, wikilink convention, and the NEVER list.

Pair with [memory.md](./memory.md) for the chat-capture half of cross-session memory.
