# RPIV questionnaire source-transform fixture

Authentic, unmodified `@juicesharp/rpiv-ask-user-question@2.13.8` npm archive.

- Source: https://registry.npmjs.org/@juicesharp/rpiv-ask-user-question/-/rpiv-ask-user-question-2.13.8.tgz
- Exact-version metadata: https://registry.npmjs.org/@juicesharp%2Frpiv-ask-user-question/2.13.8
- SHA-512 integrity: `sha512-Uu2jpn5Tf0lo47izmPU7+xbUIuxE9HdmmZ6XjVzBSm8zIvnJ5Hoj/XhfuG0qC0DuCOwIkE0oNRsNsLp1js7/2g==`
- SHA-256: `1c27ed656cf56b0af7eb45d1e4240fc3c9e3e064a05880f15acc380893159cd5`
- npm metadata gitHead: `afc21bc25f7d07cae9fb3103dc309240a16b9f49`
- Registry signatures verified against https://registry.npmjs.org/-/npm/v1/keys using key ID `SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U`. This is registry signature evidence, not a provenance attestation.
- License: MIT; original `package/LICENSE` is retained inside the archive.

Pristine source SHA-256 identities used by the reviewed transform:

- `ask-user-question.ts`: `d565f9fde43a04e6fe071ea6e0c31f16ca740bffd60b3895e9e03f785b6dd559`
- `state/questionnaire-session.ts`: `b64f47c1416aaa9d55fa5af322e2c1f2968f6e6ebe042ea91e7f2e0880f03c3c`

Used by the executable shadow-pin workflow gate fixture to exercise the real
installed-source transform before publication. Its SDK boundary remains
fixture-owned: that host test proves workflow gating, not actual SDK
compatibility. Actual package/SDK/tool behavior is tested separately by
`preseed/agents/pi/test/questionnaire-timeout.test.mjs`, using this archive and the
retained 2.12.0 archive with installed host peers. No registry access occurs during
either test, and no archive bytes or upstream integrity are rewritten.
