<!--
Copyright (C) 2026 1Claw
SPDX-License-Identifier: Apache-2.0
-->

# 3-minute demo

A run sheet, not a description. Every command here was run end to end before it
was written down; expected output is quoted so you can tell a working demo from
a broken one mid-take.

**The through-line:** an AI agent does something consequential, it never touches
a private key, and the record of what it did cannot be rewritten afterwards —
not even by us.

Both halves are live on Preprod. The agent leg broadcasts a real transaction,
and the anchor leg has a real commitment on chain. Nothing below is a fixture.

---

## Before you record

Three terminals, laid out so nothing is typed off-screen. Do all of this before
the take.

```bash
# 0. Proof server — needed by BOTH legs. An unshielded transfer has no circuit
#    of its own, but its fee is a DUST spend, and a DUST spend carries a proof.
docker ps | grep midnight-proof-server   # expect: Up ... 8.1.0

# 1. Sidecar — the Midnight signer
cd packages/midnight/packages/midnight-signer && npm start
# expect: [midnight-signer] listening on http://127.0.0.1:8091

# 2. Agent chat UI
cd examples/multichain-agent && npm run dev        # http://localhost:3000
```

Have these ready in tabs, not typed live:

- `https://1claw-anchor-viewer.vercel.app`
- `packages/midnight/contracts/audit-anchor/src/AuditAnchor.compact`

**Warm the signer before recording.** A cold wallet resumes from a checkpoint in
well under a minute, but from nothing it is about eighty minutes. Hit
`/v1/balance` once and confirm `"synced": true` before you start the take.

**Say the hackathon name in the first fifteen seconds.** It is a scored
requirement and the easiest point on the sheet to lose.

---

## 0:00 — 0:20 · The claim

> "This is 1Claw for the Midnight hackathon. An AI agent is about to move funds
> on Midnight. It will never see a private key, and every action it takes gets
> anchored on-chain so that even we cannot rewrite the record afterwards."

On screen: the agent chat at `localhost:3000`, with **Midnight Preprod**
selected. 1Claw signs for seven chains; this demo shows one, because one is what
is being judged.

Show it working before explaining how it works.

---

## 0:20 — 1:10 · The agent moves value, and never holds a key

Type into the chat, with **Midnight Preprod** selected:

```
Send 1 NIGHT to mn_addr_preprod1y3f0qfd7h8dkq2xzpqgafjg9x9fk45hkqcsjhg099kdcjcscezgslwf72u
```

Three things happen, all visible and all real:

1. **The agent forms an intent.** It holds no key material. It is asking the
   platform to act, not acting itself.
2. **Policy and guardrails evaluate it** — chain allowed, destination allowed,
   amount within cap. A denial here is the system working, not failing.
3. **The signer builds, proves, signs and broadcasts.** Keys never leave the
   sidecar; the transaction leaves it already signed.

Cut to the sidecar's answer — live data, not a fixture:

```json
{
  "night_base_units": "5000000000",
  "dust_base_units":  "5129238839999999997",
  "synced": true,
  "unshielded_address": "mn_addr_preprod1y3f0qfd7h8dkq2xzpqgafjg9x9fk45hkqcsjhg099kdcjcscezgslwf72u"
}
```

> "Five thousand NIGHT and the DUST that pays its fees, read from Preprod just
> now. The agent asked; the signer signed; the network took it."

**If you want the broadcast on camera**, run it directly — it takes about twenty
seconds end to end:

```bash
curl -s -X POST http://127.0.0.1:8091/v1/build-and-sign \
  -H 'content-type: application/json' \
  -d '{"network":"preprod","seed_hex":"'"$SEED"'","to_address":"'"$TO"'","amount_base_units":"1000000","broadcast":true}'
# {"status":"broadcast","tx_hash":"0091521a…","raw_tx":"6d69646e69676874…"}
```

That hash is real and checkable on the public indexer. The one recorded in the
README landed in **block 2344291**, carrying a `DustSpendProcessed` event —
which is the fee being paid in DUST rather than NIGHT.

**A note on the TEE.** Signing keys are held and used inside 1Claw's TEE for the
six chains where Shroud has parity. Midnight signing currently runs in the vault
with the sidecar; TEE parity is Wave 2. Say it that way — do not claim the
enclave for the Midnight path on camera.

---

## 1:10 — 2:10 · The contract, and what the proof actually claims

Cut to `AuditAnchor.compact`. Scroll to `anchorExtend` and put the three
assertions on screen:

```
assert ownerTag(sk)      == owners[key]           // caller owns this agent
assert headTag(prevHead) == commitments[key]      // prevHead is the anchored one
head := fold(prevHead, newEventHashes[0..count])  // folded in circuit
```

> "The naive version of this proves nothing. If I publish a hash of my own log,
> I picked both sides — I can rewrite the log and publish a new hash. Here the
> chain relation is *inside* the circuit. The commitment can only move forward
> by a correct extension of the real chain, by the key registered as its owner.
> Three things stay private: the events, the chain head, and which agent this
> even is."

Then run the tests on camera — they take under a second:

```bash
cd packages/midnight/contracts/audit-anchor && npm test
# expect: Test Files 1 passed (1) · Tests 12 passed (12)
```

Call out two by name as they scroll past, because they are the ones a reviewer
would otherwise have to go find:

- **`trailing padding slots are inert`** — the fold is unrolled eight times and
  every slot is guarded, so a malicious witness cannot smuggle extra events into
  unused padding. Trusting the caller to zero them would have been the shortcut.
- **`off-chain fold agrees with the circuit across a full batch`** — the viewer
  and the anchoring client both fold off-chain, and two hand-written encodings
  of one relation drift. This pins them to a single definition.

**Anchor something live**, if you want the write on camera (~40s including the
proof):

```bash
npx tsx scripts/anchor.ts --agent demo-agent --events 3
#   agent "demo-agent" -> commitment 447a28285208d82c…
#   folding 3 event(s) — anchorExtend (proving, ~30s) …
#   anchored. tx 0032e0b699…
#   local head advanced to 9a877bbd80859148…
```

---

## 2:10 — 2:45 · Verify it yourself

Switch to **https://1claw-anchor-viewer.vercel.app**.

> "This is the part I would want if I were judging. You do not have to trust the
> demo."

The table shows the anchored agent — commitment, epoch and owner tag — decoded
in the browser by the contract's **own compiled `ledger()`**, not by a
re-implementation of its storage layout:

```
agent   447a28285208d82c…   epoch 2   owner 89e838ebee93ce63…
```

> "An agent commitment, an anchor count, and an owner tag. Not the events, not
> the head, not which agent it is. That is the whole point."

Then paste a head and two event hashes into **Verify offline** and run the fold.
The page executes the contract's own compiled circuit in your browser and shows
the resulting commitment.

> "That is the contract's circuit, in your browser. If the ledger holds this
> commitment, the log you were shown is the log that was anchored."

Offline verification works with nothing deployed at all, which is exactly why it
belongs in the demo.

---

## 2:45 — 3:00 · Close

> "A Compact contract with real private state and an in-circuit chain fold.
> Ninety-six tests. An agent that moves value on Midnight without ever holding a
> key, and an audit trail that even we cannot rewrite.
> All Apache-2.0 at github.com/1clawAI/midnight. The whitepaper covers the
> threat model — including four things this deliberately does not prove."

End on the repo, not on a terminal.

---

## Reproduce every claim in this demo

A judge can run all of this cold, without a 1Claw account:

```bash
git clone https://github.com/1clawAI/midnight && cd midnight && npm install
# npm install, not npm ci: the lockfile carries dangling references into an
# optional light-client subtree (@substrate/connect -> smoldot) with no package
# entries. npm ci refuses those; npm install resolves them. Regenerating the
# lock reproduces the same gap, so it is upstream, not something to fix here.

# The contract compiles, and its circuits behave as claimed
cd contracts/audit-anchor && npm test         # 12 passed
# The signer: derivation vectors, validation, dry-run and sync-readiness rules
cd ../../packages/midnight-signer && npm test # 63 passed
# The viewer's off-chain fold agrees with the circuit
cd ../../demo/anchor-viewer && npm test       # 8 passed
# Sync liveness rules, which cost three wedged runs to get right
cd ../.. && npm run test:scripts              # 13 passed
```

On-chain, against the public indexer and needing nothing local:

```bash
# The anchor commitment
curl -s -X POST https://indexer.preprod.midnight.network/api/v4/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ contractAction(address: \"ba10cd4ac487b7a470f00ab6509295ea0673cdc5a26a866948c7bc2657fc2c86\") { __typename transaction { hash block { height } } } }"}'

# The signed transfer, by the identifier submitTransaction returned
curl -s -X POST https://indexer.preprod.midnight.network/api/v4/graphql \
  -H 'Content-Type: application/json' \
  -d '{"query":"{ transactions(offset: {identifier: \"0091521a0164efb772bc23e23c0f6325aee56063ab281c7a6e6f4344aa09c178a4\"}) { hash block { height } dustLedgerEvents { __typename } } }"}'
```

Wallet state, live:

```bash
npx tsx scripts/check-dust-registration.ts
# deployer  NIGHT 5,000  UTXOs 1  STATUS generating
```

---

## If something breaks mid-take

| Symptom | Cause | Fix |
| --- | --- | --- |
| Chat returns no signature | Sidecar not running | Terminal 1: `npm start`, wait for the listening line |
| `/v1/balance` says `"synced": false` | Wallet still catching up | Wait; from a checkpoint it is seconds, from cold ~80 min. Never demo an unsynced wallet — the balances are the checkpoint's, not the chain's |
| Signer says "still catching up and cannot assemble fees" | Same, and it is refusing rather than failing later | Wait for `"synced": true` |
| `could not balance dust` | The wallet built a transaction it never broadcast, reserving its dust coin | Restart the signer; it resumes from the last clean checkpoint |
| Viewer table is empty | Nothing anchored yet at that address | `npx tsx scripts/anchor.ts --agent demo-agent` |
| `npm test` fails in `audit-anchor` | `managed/` missing | `npm run compact` in `contracts/audit-anchor` |
| Anchor fails with `no DUST` | Fees are paid in DUST | `npx tsx scripts/register-dust.ts`, then wait for it to accrue |

**The one hard requirement:** name the hackathon on camera. Everything else on
this page is recoverable in the edit.
