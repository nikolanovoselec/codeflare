#!/usr/bin/env bash
set -euo pipefail

run_backend_tests() {
  npm test
}

run_backend_tests
