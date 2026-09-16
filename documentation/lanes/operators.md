# Operator Interface foundation

**Audience:** Platform and operator developers

**Owns:** Enterprise Operator Interface input formats and reusable platform boundaries.

**Does not own:** Private Flue code, Review business logic, canonical local-review resources, enterprise permission grants or deployment secrets.

Implementation is incremental. The functions below do not constitute a deployed operator runtime. Requirements and remaining acceptance live in [Operators](../../sdd/spec/operators.md).

## Verified human context

`src/lib/jwt.ts::verifyHumanAccessJWT(token, authDomain, audience)` returns signed human subject/email/issuer/audiences and actual issued-at/expiry, or null. It shares cryptographic verification with the unchanged ordinary email API. It does not return the token, grant operator eligibility, resolve an owner bucket or renew authority. See [Authentication](authentication.md#human-access-claims-for-the-operator-interface).

## Distribution validation

`src/operators/distribution.ts` provides pure typed boundaries:

- `parseOperatorManifest(json, endpoint)` validates at most 64 KiB of discovery JSON and resolves a canonical artifact path only against the registered HTTPS origin.
- `parseOperatorBundle(bytes, approvedSha256)` checks at most 8 MiB of exact artifact bytes, validates compatible JS/text modules and returns data without executing it. The bundle cannot supply environment bindings or outbound configuration.

Both reject invalid input with a safe `ValidationError`. Network callers must still bound responses before buffering, authenticate the invoking human and connection secret, reject redirects/login responses and enforce artifact approval. An advertised digest is integrity metadata, not independent publisher authenticity or user eligibility.

### Discovery v1

```json
{
  "schemaVersion": 1,
  "interfaceVersion": 1,
  "id": "example-operator",
  "name": "Example operator",
  "description": "Platform acceptance fixture",
  "coreVersion": "1.0.0",
  "intentVersion": "1.0.0",
  "inputSchema": { "type": "object" },
  "requiredCapabilities": ["inference", "session", "storage"],
  "artifact": {
    "path": "/bundles/example.json",
    "sha256": "<lowercase SHA-256 of exact bundle bytes>"
  }
}
```

Supported capability names are `session`, `pi`, `storage`, `inference` and `fetch`. Declaring one requests compatibility, not permission. Duplicate/unknown capabilities, unknown schema/interface versions and caller identity/binding fields fail validation. `inputSchema` is bounded JSON metadata, not executable code or a new schema interpreter.

### Bundle v1

```json
{
  "schemaVersion": 1,
  "interfaceVersion": 1,
  "compatibilityDate": "2026-02-05",
  "compatibilityFlags": ["nodejs_compat"],
  "mainModule": "index.js",
  "modules": {
    "index.js": { "js": "export default {};" },
    "resources/intent.txt": { "text": "Approved intent resource" }
  }
}
```

This is a format example, not a functioning operator. At most 128 canonical relative module names are accepted and the declared main module must be JavaScript. Compatibility settings match the platform; accepting a new setting requires an explicit tested platform change. Parent-provided capabilities, execution, checkpointing, interception and activity admission are separate runtime responsibilities.

## Verification

Behavioral tests in `src/__tests__/lib/jwt.test.ts` cover signed human identity versus legacy email authentication. `src/__tests__/operators/distribution.test.ts` covers bounded metadata, origin confinement, exact-byte integrity, module restrictions and non-execution. Full live distribution/Worker acceptance remains a separate requirement; parser tests do not prove it.
