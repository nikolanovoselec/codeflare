# Pending Items

Prose-level detail on REQ Status fields that are not yet `Implemented`. The REQ's Status field is the canonical signal (`Partial` = built but some AC unmet or no automated verification); entries here explain WHY a REQ is Partial and what closes the gap.

---

## REQ-VAULT-008 -- ACs 3, 4, 5 blocked on SilverBullet upstream; AC8/AC9 IDB deletion deferred

AC3 (SilverBullet consumes `bootConfig.vaultEncryptionKey` and uses it as the IDB encryption key without prompting), AC4 (`syncConcurrency = 15`), and AC5 (lazy `Raw/Pasted/**` sync) all require SilverBullet 2.x to accept the configuration hooks exposed via the Worker-side `window.__codeflareVaultBoot` script injection. Status: Partial until SB upstream lands the consumer code (or codeflare ships a patched bundle); automated verification then becomes possible.

AC8 (`cleanupSessionVaultCache` deletes the per-session IDB on session DELETE) and AC9 (`sweepOrphanVaultCaches` nukes orphan IDBs on dashboard mount) currently cover only the dashboard-side bookkeeping — localStorage markers and the per-session service-worker registration. IDB deletion is intentionally absent because SilverBullet's IDB names are `sb_<type>_<sha256(spaceFolderPath:baseURI:key)>` (see upstream `plug-api/lib/crypto.ts:deriveDbName`), so the dashboard cannot identify which IDB belongs to which session without the encryption key, spaceFolderPath, and baseURI — none of which it has. An earlier implementation parsed `parts[2]` of the name as the sid and consequently nuked every SilverBullet IDB on every dashboard mount, forcing a full resync on each SB reopen. The fix is blocked on AC3 above: once SilverBullet consumes our injected key (or we ship a patched bundle), we can record the sid -> IDB-name mapping at boot and use it here.

The Worker-side infrastructure (DO key persistence, /.config injection, boot-script HTML rewrite, /.fs filter, treeview exclude) is fully implemented and covered by tests — ACs 1, 2, 6, 7 are honest Implemented. AC8/AC9 are honest Partial (marker + SW cleanup only; IDB deletion deferred).

---

## REQ-STOR-015 -- AC5, AC6 lack automated test coverage

After the upload-side auto-trigger was removed (originally AC4, see AD56 note), the remaining ACs renumber to: AC1 fan-out endpoint, AC2 concurrency cap, AC3 per-session isolation, AC4 rate-limit shape, AC5 SIGUSR1 coalesce/rerun, AC6 button-disabled-while-syncing.

AC1-AC4 have unit + static-file coverage from the PR-E backfill plus the inverse "upload.ts has no fan-out wiring" guard. AC5 (coalesced-rerun after mid-flight signal) and AC6 (frontend button disabled state) are not yet covered by automated tests. Status: Partial until covered.
