# pi-mcp-adapter 5.3.1 test fixture

- Source: https://registry.npmjs.org/pi-mcp-adapter/-/pi-mcp-adapter-5.3.1.tgz
- Package/version: `pi-mcp-adapter@5.3.1`
- License: MIT; upstream license files remain inside the unmodified archive.
- Compressed bytes: `1961048`
- SHA-256: `b87296a4b3851784f838ea10c6f68aaa872f77f92199e76688d27130319df63f`
- SHA-512 SRI: `sha512-3b7DxTc7g1vbHngJY59nfcykel1iihSSJ1jv+4kkMSGJteTI/W7N8NNV2MrqX/HTdVFgd5OIcET8OeIcgG175A==`

The bytes match the committed `preseed/agents/pi/package-lock.json` entry. The archive contains only relative `package/` regular-file/directory members. It is test-owned, not an installed runtime or managed seed artifact.

`preseed/agents/pi/test/consult-proxy.test.mjs` verifies the exact version and lock integrity, then compiles the complete upstream-declared `./index.ts` extension in CI. The adapter and MCP transport are real; only the external consult service and Pi host API are fixtures. Lazy startup, proxy-only schema exposure, credential delivery and cleanup assertions are retained. This provenance is not passing runtime evidence.
