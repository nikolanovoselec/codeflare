# Local execution gate

Builds, tests, type checks, dependency-graph analysis, installs, servers, and direct analyzers are CI-only. When a read-only local lint or syntax check is useful, load `safe-local-checks` and use only its managed wrapper; never create the user-only bypass.
