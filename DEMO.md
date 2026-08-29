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

---

## Before you record

Four terminals, laid out so nothing is typed off-screen. Do all of this before
the take.

```bash
# 0. Proof server (needed only if you deploy live; skip otherwise)
docker ps | grep midnight-proof-server   # expect: Up

# 1. Sidecar — the Midnight signer
cd packages/midnight/packages/midnight-signer && npm start
# expect: [midnight-signer] listening on http://127.0.0.1:8091

# 2. Agent chat UI
cd examples/multichain-agent && npm run dev        # http://localhost:3000

# 3. Anchor viewer — use the hosted one, it is one less thing to fail
open https://1claw-anchor-viewer.vercel.app
```

Have these ready in tabs, not typed live:

- `https://1claw-anchor-viewer.vercel.app`
- `packages/midnight/contracts/audit-anchor/src/AuditAnchor.compact`

**Say the hackathon name in the first fifteen seconds.** It is a scored
requirement and it is the easiest point on the sheet to lose.

---

## 0:00 — 0:25 · The claim

> "This is 1Claw for the Midnight hackathon. An AI agent is about to move funds
> on Midnight. It will never see a private key, and every action it takes gets
> anchored on-chain so that even we cannot rewrite the record afterwards."

On screen: the agent chat at `localhost:3000`, with **Midnight Preprod**
selected. 1Claw signs for seven chains; this demo shows one, because one is what
is being judged.

Do not explain the architecture yet. Show it working first.

---

## 0:25 — 1:20 · The agent acts, and never holds a key

This is the moment that lands. Everything here is Midnight — no other chain
appears in this demo, because none is the point.

Type into the chat, with **Midnight Preprod** selected:

```
Send 1 NIGHT to mn_addr_preprod1z9w85pl08f8gpyn0ge0zja9wedfy50r9qxv85wjl4znj9t6eyreq3ue2py
```

Narrate the three things that happen, because they are all visible and all real:

1. **The agent forms an intent.** It holds no key material. It is asking the
   platform to act, not acting itself.
2. **Policy and guardrails evaluate it** — chain allowed, destination allowed,
   amount within cap. A denial here is the system working, not failing.
3. **The signer resolves it against the live chain.** The destination is
   validated as a real Midnight address, the balance is read from the Preprod
   indexer, and the transfer is dry-run before anything is signed.

Cut to the sidecar's answer — this is live data, not a fixture:

```json
{
  "unshielded_address": "mn_addr_preprod1rvf6kcas7k42n5s7qslxstqzae0wwv4ljhudgaszkhdgzzx7jmqqf8apt2",
  "to_address":         "mn_addr_preprod1z9w85pl08f8gpyn0ge0zja9wedfy50r9qxv85wjl4znj9t6eyreq3ue2py",
  "night_base_units":   "5000000000",
  "dust_base_units":    "0",
  "ok": false,
  "problems": ["no DUST — fees are paid in DUST, and this NIGHT is not registered to generate it"]
}
```

> "Five thousand NIGHT, read from the Preprod indexer just now. The address is
> validated, the amount is within policy, the transaction is built. It stops at
> one place: this NIGHT was never registered for DUST generation, and DUST is
> what pays fees."

**Say that plainly and keep moving.** It is a documented, reproducible finding —
faucet NIGHT arrives with `registeredForDustGeneration=false`, registration is
only reachable through the Lace wallet, and Lace derives a different wallet from
the same recovery phrase than the SDK does. The README carries the 320
derivations we searched before concluding that. A judge who runs
`check-dust-registration.ts` sees exactly this, so naming it is stronger than
routing around it.

> "One registration step from broadcasting. Everything above it is real."

**A note on the TEE.** Signing keys are held and used inside 1Claw's TEE for the
six chains where Shroud has parity. Midnight signing currently runs in the vault
with the sidecar; TEE parity is Wave 2. Say it that way — do not claim the
enclave for the Midnight path on camera.

## 1:20 — 2:15 · The contract, and what the proof actually claims

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
would otherwise have to find:

- **`trailing padding slots are inert`** — the fold is unrolled eight times and
  every slot is guarded, so a malicious witness cannot smuggle extra events into
  unused padding. Trusting the caller to zero them would have been the shortcut.
- **`off-chain fold agrees with the circuit across a full batch`** — the viewer
  and the anchoring client both fold off-chain, and two hand-written encodings
  of one relation drift. This pins them to a single definition.

---

## 2:15 — 2:45 · Verify it yourself

Switch to **https://1claw-anchor-viewer.vercel.app**.

> "This is the part I would want if I were judging. You do not have to trust the
> demo."

Paste a head and two event hashes into **Verify offline** and run the fold. The
page executes **the contract's own compiled circuit** in the browser — the same
`managed/` artifact that deploys, not a re-implementation — and shows the
resulting commitment.

> "That is the contract's own circuit, in your browser. If the ledger holds this
> commitment, the log you were shown is the log that was anchored."

This works with nothing deployed, which is exactly why it belongs in the demo.

---

## 2:45 — 3:00 · Close

> "Compact contract with real private state and an in-circuit chain fold.
> Fifty-six tests. An agent that moves value on Midnight without ever holding a
> key.
> All Apache-2.0 at github.com/1clawAI/midnight. The whitepaper covers the threat
> model — including four things this deliberately does not prove."

End on the repo, not on a terminal.

---

## Reproduce every claim in this demo

A judge can run all of this cold, without a 1Claw account:

```bash
git clone https://github.com/1clawAI/midnight && cd midnight && npm ci

# The contract compiles, and its circuits behave as claimed
cd contracts/audit-anchor && npm test        # 12 passed
# The signer: derivation vectors, validation, dry-run failure paths
cd ../../packages/midnight-signer && npm test # 36 passed
# The viewer's off-chain fold agrees with the circuit
cd ../../demo/anchor-viewer && npm test       # 8 passed
```

Wallet state, against the live Preprod indexer:

```bash
npx tsx scripts/check-dust-registration.ts
# deployer  NIGHT 5,000  UTXOs 1  (0 registered for DUST generation)
```

That last command is also the reproduction of the DUST finding. It is honest
output, and it is why the Midnight leg of the demo stops where it does.

---

## If something breaks mid-take

| Symptom | Cause | Fix |
| --- | --- | --- |
| Chat returns no signature | Sidecar not running | Terminal 1: `npm start`, wait for the listening line |
| Midnight transfer stops at fees | Expected, and scripted — NIGHT not registered | Say so and move on; do not improvise |
| Viewer says "No config.json" | Nothing deployed yet | Expected; offline verification still works |
| Viewer shows a Vercel login | You used a per-deploy URL | Use `1claw-anchor-viewer.vercel.app` — only the alias is public |
| `npm test` fails in `audit-anchor` | `managed/` missing | `npm run compact` in `contracts/audit-anchor` |

**The one hard requirement:** name the hackathon on camera. Everything else on
this page is recoverable in the edit.
