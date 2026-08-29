#!/usr/bin/env bash
# Wait for DUST to accrue, then deploy AuditAnchor exactly once.
#
#   ./scripts/watch-dust-and-deploy.sh              # run in the foreground
#   nohup ./scripts/watch-dust-and-deploy.sh &      # survive the terminal
#
# DUST is what pays fees, and it does NOT appear merely because a wallet holds
# NIGHT — the NIGHT has to be registered on-chain for DUST generation first (see
# "Funding a Preprod wallet" in the README). This waits for DUST to appear after
# that registration; it cannot cause it. If NIGHT is present and DUST stays at
# zero, the registration step is missing and this says so rather than waiting
# out the clock. Everything is logged to .dust-watch.log.
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

# DUST accrues over hours once registered; polling faster just spins a wallet sync.
INTERVAL_SECS="${DUST_POLL_INTERVAL:-600}"

# How many consecutive "NIGHT but no DUST" polls before calling it: at the
# default interval this is an hour. Registered NIGHT starts generating well
# inside that, so a flat zero past it means registration never happened — and
# continuing to log "waiting" would misrepresent a missing step as a slow one.
UNREGISTERED_AFTER="${DUST_UNREGISTERED_AFTER:-6}"
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

# ── Publish the viewer once there is an address to show ──────────────────────
#
# Separated from the deploy so its failure is reported as what it is. The
# contract deployment is the irreversible part and it has already succeeded by
# the time this runs; a failed site publish is an inconvenience to redo by hand,
# not a reason to report the whole run as failed.
publish_viewer() {
  local addr="$1"
  local site="${ANCHOR_VIEWER_URL:-https://1claw-anchor-viewer.vercel.app}"

  if [[ -z "$addr" ]]; then
    say "WARN: deploy reported success but no contractAddress in $VIEWER_CONFIG — skipping publish."
    return
  fi
  if ! command -v vercel >/dev/null 2>&1; then
    say "WARN: vercel CLI not found — publish by hand: (cd $ROOT && vercel deploy --prod)"
    return
  fi

  say "publishing viewer with the new address ..."
  if ! (cd "$ROOT" && vercel deploy --prod --yes >>"$LOG" 2>&1); then
    say "WARN: vercel publish failed — the CONTRACT IS DEPLOYED at $addr."
    say "      Retry with: (cd $ROOT && vercel deploy --prod)"
    return
  fi

  # A publish that returns success but serves the old bundle is the failure
  # worth catching: config.json is marked no-store, so a correct deploy shows
  # the new address almost immediately.
  for _ in $(seq 1 20); do
    local live
    live=$(curl -s --max-time 15 "$site/config.json" 2>/dev/null \
           | python3 -c "import sys,json;print(json.load(sys.stdin).get('contractAddress',''))" 2>/dev/null)
    if [[ "$live" == "$addr" ]]; then
      say "LIVE: $site is serving $addr"
      say "commit the address into the repo:  git add $VIEWER_CONFIG && git commit"
      return
    fi
    sleep 15
  done
  say "WARN: published, but $site/config.json does not yet show $addr (CDN lag, or the build did not pick it up)."
}

# ── Poll ─────────────────────────────────────────────────────────────────────
DRY_SPELL=0
for poll in $(seq 1 "$MAX_POLLS"); do
  BAL=$(curl -s --max-time 180 -X POST "$SIGNER_URL/v1/balance" \
        -H "Content-Type: application/json" \
        -d "{\"seed_hex\":\"$SEED\",\"network\":\"preprod\"}")
  DUST=$(echo "$BAL" | python3 -c "import sys,json;print(json.load(sys.stdin).get('dust_base_units','0'))" 2>/dev/null)
  NIGHT=$(echo "$BAL" | python3 -c "import sys,json;print(json.load(sys.stdin).get('night_base_units','0'))" 2>/dev/null)
  DUST="${DUST:-0}"; NIGHT="${NIGHT:-0}"

  if [[ "$NIGHT" == "0" ]]; then
    say "poll $poll/$MAX_POLLS: no NIGHT at all — fund the unshielded address at the faucet first."
    say "  https://faucet.preprod.midnight.network/"
  fi

  if [[ "$DUST" != "0" && -n "$DUST" ]]; then
    DRY_SPELL=0
    say "poll $poll/$MAX_POLLS: DUST=$DUST NIGHT=$NIGHT — deploying"
    if bash "$ROOT/scripts/deploy-anchor.sh" >>"$LOG" 2>&1; then
      ADDR=$(python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('contractAddress',''))" "$VIEWER_CONFIG" 2>/dev/null)
      say "DEPLOYED: ${ADDR:-see log}"
      publish_viewer "$ADDR"
      exit 0
    fi
    # A failed deploy is worth retrying: the usual cause is DUST that has only
    # just started accruing and does not yet cover the fee. Keep waiting rather
    # than giving up on a transient shortfall.
    say "poll $poll/$MAX_POLLS: deploy failed (likely not enough DUST yet) — see $LOG"
  else
    say "poll $poll/$MAX_POLLS: DUST=0 NIGHT=$NIGHT — waiting"
    if [[ "$NIGHT" != "0" ]]; then
      DRY_SPELL=$((DRY_SPELL + 1))
      if [[ "$DRY_SPELL" -ge "$UNREGISTERED_AFTER" ]]; then
        say ""
        say "STOPPING: $NIGHT NIGHT held, DUST still zero after $DRY_SPELL polls."
        say "  Holding NIGHT does not generate DUST. The NIGHT has to be registered"
        say "  on-chain for DUST generation, and nothing here can do that for you —"
        say "  the indexer keys generation on a Cardano reward address, not on this"
        say "  Midnight address (dustGenerationStatus.registered)."
        say ""
        say "  Do the registration step, then re-run this script."
        say "  See 'Funding a Preprod wallet' in README.md."
        exit 2
      fi
    fi
  fi

  [[ "$poll" -lt "$MAX_POLLS" ]] && sleep "$INTERVAL_SECS"
done

say "gave up after $MAX_POLLS polls. DUST never accrued — check the wallet still holds NIGHT."
exit 1
