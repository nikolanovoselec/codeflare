# Pending Items

Prose-level detail on REQ Status fields that are not yet `Implemented`. The REQ's Status field is the canonical signal (`Partial` = built but some AC unmet or no automated verification); entries here explain WHY a REQ is Partial and what closes the gap.

---

## REQ-VAULT-008 -- ACs 3, 4, 5 blocked on SilverBullet upstream

AC3 (SilverBullet consumes `bootConfig.vaultEncryptionKey` and uses it as the IDB encryption key without prompting), AC4 (`syncConcurrency = 15`), and AC5 (lazy `Raw/Pasted/**` sync) all require SilverBullet 2.x to accept the configuration hooks exposed via the Worker-side `window.__codeflareVaultBoot` script injection. Status: Partial until SB upstream lands the consumer code (or codeflare ships a patched bundle); automated verification then becomes possible.

The Worker-side infrastructure (DO key persistence, /.config injection, boot-script HTML rewrite, /.fs filter, IDB cleanup, treeview exclude) is fully implemented and covered by tests — ACs 1, 2, 6, 7, 8, 9 are honest Implemented.

---

## REQ-STOR-015 -- ACs 2, 3, 6, 7 lack automated test coverage

AC2 (signal-triggered sync from UI), AC3 (upload auto-trigger), AC6 (multi-session fan-out), AC7 (coalesced-rerun after mid-flight signal) are not yet covered by automated tests. Status: Partial until covered. AC1, AC4, AC5 have unit + static-file coverage from the PR-E backfill.
