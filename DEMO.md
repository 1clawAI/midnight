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

On screen: the agent chat at `localhost:3000`, chain selector open showing
**Midnight Preprod** alongside the six other chains.

Do not explain the architecture yet. Show it working first.

---

## 0:25 — 1:15 · The agent signs, and never holds a key

This is the moment that lands. Type into the chat:

```
Send 1 NIGHT to mn_addr_preprod1z9w85pl08f8gpyn0ge0zja9wedfy50r9qxv85wjl4znj9t6eyreq3ue2py
```

Narrate while it runs — three things happen and they are all visible:

1. **The agent forms an intent.** It has no key material. It is asking the
   platform to act, not acting itself.
2. **Policy and guardrails evaluate it** — chain allowed, destination allowed,
   amount within cap. A denial here would be the demo working, not failing.
3. **Signing happens inside the TEE.** The key is unwrapped in Shroud, used, and
   never leaves. The agent gets a signed transaction back, not a key.

> "The agent asked. The platform decided. The key never left the enclave."

**Switch chain to Ethereum Sepolia and send the same instruction.** It signs and
broadcasts, and you get a real transaction hash to click. Same agent, same
sentence, different chain — that is the platform claim proved rather than
asserted.

> **On Midnight specifically:** the transfer stops at the fee step, because
> Preprod NIGHT has to be registered for DUST generation before it can pay one,
> and registration is only reachable through the Lace browser wallet — which
> derives a different wallet from the same recovery phrase than the SDK does.
> **Say this out loud rather than editing around it.** It is a real,
> reproducible finding, it is documented in the README with the 320 derivations
> we searched, and naming it is stronger than hiding it. Then move to Sepolia,
> where the identical path completes.

---

## 1:15 — 2:10 · The contract, and what the proof actually claims

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

## 2:10 — 2:45 · Verify it yourself

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
> Fifty-six tests. A signer that keeps keys inside a TEE across seven chains.
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
| Midnight transfer fails at fees | Expected — NIGHT not registered for DUST | Say so, switch to Sepolia |
| Viewer says "No config.json" | Nothing deployed yet | Expected; offline verification still works |
| Viewer shows a Vercel login | You used a per-deploy URL | Use `1claw-anchor-viewer.vercel.app` — only the alias is public |
| `npm test` fails in `audit-anchor` | `managed/` missing | `npm run compact` in `contracts/audit-anchor` |

**The one hard requirement:** name the hackathon on camera. Everything else on
this page is recoverable in the edit.
