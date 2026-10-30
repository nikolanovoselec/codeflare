# RPIV questionnaire source-transform fixture

Authentic, unmodified `@juicesharp/rpiv-ask-user-question@2.15.0` npm archive.

- Source: https://registry.npmjs.org/@juicesharp/rpiv-ask-user-question/-/rpiv-ask-user-question-2.15.0.tgz
- Exact-version metadata: https://registry.npmjs.org/@juicesharp%2Frpiv-ask-user-question/2.15.0
- SHA-512 integrity: `sha512-Gm6de5IZF52BaSeh9dnDqJBn821Z5XfJkCmhkCmqTzvNv3SCpSv1mA4Gj5VBcfrSe+xTtWSVQzJwIqJFQHH3Lg==`
- SHA-256: `3b3dfb5f2836e897c2884a70a80afcde2a5370af4ced8a2c927e0ed7bf8fb81f`
- npm metadata gitHead: `ce6d3530410812ca504ec294995581a52170f9e1`
- Size: 107333 bytes.
- Downloaded once from the authoritative npm registry; archive SHA-512 verified against exact-version `dist.integrity`. No registry-signature or provenance-attestation verification is claimed.
- License: MIT; original `package/LICENSE` is retained inside the archive.

Pristine source SHA-256 identities used by the reviewed transform:

- `ask-user-question.ts`: `f9c13238db876203522b28a4a392976b7775e326424f93f6fd62ec7fdf13deb9`
- `state/questionnaire-session.ts`: `0b452327088858ac04cd1c7000f45a9301ae48a6b4a3b18d147d8068804bcccd`

The existing actual-package questionnaire matrix exercises repeat preparation,
native deadlines/state, and the public external-answer API's shared settlement
with the deadline. The existing shadow-pin workflow fixture exercises authentic
transforms with a fixture-owned SDK boundary: it proves publication gating, not
actual SDK compatibility. Tests use this retained archive without registry access
or rewritten upstream archive/integrity bytes. Test execution remains CI-only;
fixture verification is not passing behavioral evidence.
