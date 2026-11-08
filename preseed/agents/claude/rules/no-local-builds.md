# Local execution gate

Builds and unit tests are CI-only regardless of deployment CPU, memory or storage. Integration tests, type checks, dependency-graph analysis, installs, servers and direct analyzers are also CI-only. For read-only local lint or syntax checks, load `safe-local-checks` and use only its managed wrapper; never create the user-only bypass.
