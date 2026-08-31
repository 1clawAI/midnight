#!/usr/bin/env bash
# Deploy AuditAnchor to Preprod. Thin wrapper so the entry point matches the
# plan and so preflight failures read clearly in a terminal.
set -euo pipefail
cd "$(dirname "$0")/.."

MANAGED="contracts/audit-anchor/src/managed/audit-anchor"

# Compile only when the output is missing or older than the source.
#
# `npm run compact` regenerates ~24MB of proving keys and takes minutes, and it
# ran unconditionally on every invocation — including the six retries it took to
# land the first deploy, where the contract had not changed once. That is slow
# enough that it pushes people toward calling the TypeScript directly, which
# then skips the compile on the one run where it *was* needed.
#
# ONECLAW_FORCE_COMPACT=1 recompiles regardless.
needs_compile() {
    [[ "${ONECLAW_FORCE_COMPACT:-}" == "1" ]] && return 0
    [[ ! -f "$MANAGED/contract/index.js" ]] && return 0
    # Any .compact source newer than the built module.
    if find contracts/audit-anchor/src -name '*.compact' -newer "$MANAGED/contract/index.js" \
        -print -quit 2>/dev/null | grep -q .; then
        return 0
    fi
    return 1
}

if needs_compile; then
    echo "==> compiling contract"
    (cd contracts/audit-anchor && npm run --silent compact)
else
    echo "==> contract up to date (set ONECLAW_FORCE_COMPACT=1 to rebuild)"
fi

echo "==> deploying"
npx tsx scripts/deploy-anchor.ts
