---
paths:
  - "**/*.go"
  - "**/go.mod"
  - "**/go.sum"
---
# Go Testing

**Important:** Tests run via CI only (GitHub Actions). Do not run test suites locally — the container is resource-constrained. Write tests, push, and verify via `gh run view`.

## Framework

Use the standard `go test` with **table-driven tests**.

## Race Detection (CI only)

Always run with the `-race` flag in CI:

```bash
go test -race ./...
```

## Coverage (CI only)

```bash
go test -cover ./...
```
