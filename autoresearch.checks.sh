#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT"

npm run build >/dev/null
node eval/human-e2e/checks/validate-trace.js
node eval/human-e2e/checks/no-leftovers.js
