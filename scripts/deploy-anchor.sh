#!/usr/bin/env bash
# Deploy AuditAnchor to Preprod. Thin wrapper so the entry point matches the
# plan and so preflight failures read clearly in a terminal.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "==> compiling contract"
(cd contracts/audit-anchor && npm run --silent compact)

echo "==> deploying"
npx tsx scripts/deploy-anchor.ts
