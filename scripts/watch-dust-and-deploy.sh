#!/usr/bin/env bash
# Wait for DUST to accrue, then deploy AuditAnchor exactly once.
#
#   ./scripts/watch-dust-and-deploy.sh              # run in the foreground
#   nohup ./scripts/watch-dust-and-deploy.sh &      # survive the terminal
#
# DUST accrues from held NIGHT over hours, so this polls slowly and is designed
# to be left alone. Everything it does is logged to .dust-watch.log.
#
# It will not deploy twice. A contract address already recorded in the viewer
# config means the work is done — deploying again would spend DUST to create a
# second, unreferenced contract and leave the viewer pointing at the first.
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

SIGNER_DIR="$ROOT/packages/midnight-signer"
VIEWER_CONFIG="$ROOT/demo/anchor-viewer/config.json"
LOG="$ROOT/.dust-watch.log"
SIGNER_URL="${MIDNIGHT_SIGNER_URL:-http://127.0.0.1:8091}"
PROOF_URL="${MIDNIGHT_PROOF_SERVER_URL:-http://127.0.0.1:6300}"

# DUST accrues over hours; polling faster just spins a wallet sync.
INTERVAL_SECS="${DUST_POLL_INTERVAL:-600}"
# ~24h at the default interval. A cap means a forgotten background job stops.
MAX_POLLS="${DUST_MAX_POLLS:-144}"

say() { echo "[$(date -u +%H:%M:%SZ)] $*" | tee -a "$LOG"; }

STARTED_SIGNER=""
cleanup() { [[ -n "$STARTED_SIGNER" ]] && kill "$STARTED_SIGNER" 2>/dev/null; }
trap cleanup EXIT

say "── DUST watch started (every $((INTERVAL_SECS / 60))m, max $MAX_POLLS polls) ──"

# ── Already done? ────────────────────────────────────────────────────────────
if [[ -f "$VIEWER_CONFIG" ]]; then
  EXISTING=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('contractAddress',''))" "$VIEWER_CONFIG" 2>/dev/null)
  if [[ -n "$EXISTING" ]]; then
    say "already deployed at $EXISTING — nothing to do."
    say "to redeploy deliberately, clear contractAddress in $VIEWER_CONFIG first."
    exit 0
  fi
fi

# ── Preconditions that will not fix themselves ───────────────────────────────
if ! curl -sf --max-time 5 "$PROOF_URL/health" >/dev/null 2>&1; then
  say "FATAL: proof server unreachable at $PROOF_URL. Deployment proves a circuit, so"
  say "       this cannot succeed later on its own. Start it, then re-run:"
  say "       docker run -d -p 6300:6300 midnightntwrk/proof-server:9.0.0-rc.7-arm64 \\"
  say "         -- midnight-proof-server --network testnet"
  exit 1
fi
say "proof server reachable"

if [[ ! -f "$ROOT/.env.local" ]]; then
  say "FATAL: no .env.local — run 'npm run sync-wallets' first."
  exit 1
fi
SEED=$(grep -E '^MIDNIGHT_DEPLOYER_SEED=' "$ROOT/.env.local" | cut -d= -f2- | tr -d "\"'")
if [[ -z "${SEED:-}" ]]; then
  say "FATAL: MIDNIGHT_DEPLOYER_SEED missing from .env.local"
  exit 1
fi

# ── Keep one synced wallet rather than rebuilding it every poll ──────────────
if ! curl -sf --max-time 3 "$SIGNER_URL/healthz" >/dev/null 2>&1; then
  say "starting midnight-signer (wallet sync is slow; reusing one process)"
  ( cd "$SIGNER_DIR" && npm start >>"$ROOT/.dust-watch-signer.log" 2>&1 & echo $! >/tmp/dust-watch-signer.pid )
  STARTED_SIGNER=$(cat /tmp/dust-watch-signer.pid 2>/dev/null)
  for _ in $(seq 1 60); do
    curl -sf --max-time 2 "$SIGNER_URL/healthz" >/dev/null 2>&1 && break
    sleep 2
  done
fi
curl -sf --max-time 5 "$SIGNER_URL/healthz" >/dev/null 2>&1 \
  && say "signer reachable at $SIGNER_URL" \
  || { say "FATAL: signer would not start — see .dust-watch-signer.log"; exit 1; }

# ── Poll ─────────────────────────────────────────────────────────────────────
for poll in $(seq 1 "$MAX_POLLS"); do
  BAL=$(curl -s --max-time 180 -X POST "$SIGNER_URL/v1/balance" \
        -H "Content-Type: application/json" \
        -d "{\"seed_hex\":\"$SEED\",\"network\":\"preprod\"}")
  DUST=$(echo "$BAL" | python3 -c "import sys,json;print(json.load(sys.stdin).get('dust_base_units','0'))" 2>/dev/null)
  NIGHT=$(echo "$BAL" | python3 -c "import sys,json;print(json.load(sys.stdin).get('night_base_units','0'))" 2>/dev/null)
  DUST="${DUST:-0}"; NIGHT="${NIGHT:-0}"

  if [[ "$NIGHT" == "0" ]]; then
    say "poll $poll/$MAX_POLLS: no NIGHT — DUST accrues from *held* NIGHT, so this will never progress. Fund the wallet."
  fi

  if [[ "$DUST" != "0" && -n "$DUST" ]]; then
    say "poll $poll/$MAX_POLLS: DUST=$DUST NIGHT=$NIGHT — deploying"
    if bash "$ROOT/scripts/deploy-anchor.sh" >>"$LOG" 2>&1; then
      ADDR=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('contractAddress',''))" "$VIEWER_CONFIG" 2>/dev/null)
      say "DEPLOYED: ${ADDR:-see log}"
      say "point the viewer at it:  cd demo/anchor-viewer && npm run dev"
      exit 0
    fi
    # A failed deploy is worth retrying: the usual cause is DUST that has only
    # just started accruing and does not yet cover the fee. Keep waiting rather
    # than giving up on a transient shortfall.
    say "poll $poll/$MAX_POLLS: deploy failed (likely not enough DUST yet) — see $LOG"
  else
    say "poll $poll/$MAX_POLLS: DUST=0 NIGHT=$NIGHT — waiting"
  fi

  [[ "$poll" -lt "$MAX_POLLS" ]] && sleep "$INTERVAL_SECS"
done

say "gave up after $MAX_POLLS polls. DUST never accrued — check the wallet still holds NIGHT."
exit 1
