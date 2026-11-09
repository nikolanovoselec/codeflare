# Local checks

Builds, package test scripts, broad integration tests, type checks, dependency-graph analysis, installs, servers and direct analyzers are CI-only regardless of deployment CPU, memory or storage. Local tests and approved lint/syntax checks use only the tuned `safe-local-checks` wrapper; load its skill; preserve all supported modes and bounds. Never create the user-only bypass.
