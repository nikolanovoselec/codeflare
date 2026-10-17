# Open TUI 0.3.11 test artifact

- Package: `pi-open-tui@0.3.11`, MIT.
- Registry archive: https://registry.npmjs.org/pi-open-tui/-/pi-open-tui-0.3.11.tgz
- SHA-512 integrity: `sha512-/uT5QZTFl1/GyO4Nre3u1cIOBBgDsX96ze3F0doxNKi4EsKvOqgTovRpYqbLASKTfljs612bH7I2J1wZQJzTcw==`.
- Upstream: https://github.com/OldSuns/pi-open-tui/tree/766ccab7b40df6fb9682a105a05d3838803c3d4b

The archive is unchanged test data. Its included LICENSE, package metadata and native TypeScript sources were inspected before adoption. No production source transform, renderer fork or vendored runtime installation is used. Production consumes the exact registry dependency in the Pi lockfile; the native SDK/TUI suite stages matching archive bytes in a temporary agent layout.

Future shadow-pin candidates fetch their exact lock-integrity-matched archive and check the same settings/cache contracts before pushing a candidate branch. Native candidate code executes in ordinary read-only PR Checks, not the write-token publication step. Artifact integrity, authored tests and source CI are not packaged-image or deployed terminal acceptance.
