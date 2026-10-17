# RPIV questionnaire source-transform fixture

Authentic, unmodified `@juicesharp/rpiv-ask-user-question@2.12.0` npm archive.

- Source: https://registry.npmjs.org/@juicesharp/rpiv-ask-user-question/-/rpiv-ask-user-question-2.12.0.tgz
- SHA-512 integrity: `sha512-DilWc7u25SwnK6ytuAWOTerP0AmOEfK4HXpgS1oEzkgv9d5g5T+PbLG+zcLn18M3B/J3poMG14iydG5O6iBsnw==`
- SHA-256: `f407893638f1893a3730444f467b4edc1924cf2d206ae584f7525e1e8ae860f6`
- License: MIT; original `package/LICENSE` is retained inside the archive.

Used by the existing executable shadow-pin workflow gate fixture to exercise the
real installed-source transform before publication. Its SDK boundary remains
fixture-owned; actual SDK/tool behavior is tested separately by
`preseed/agents/pi/test/questionnaire-timeout.test.mjs`. No registry access occurs
during this host test, and no artifact bytes or upstream integrity are rewritten.
