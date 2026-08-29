# 1Claw × Midnight — policy-gated agent signing with an on-chain audit anchor

Apache-2.0. Built for Midnight Wave Hacks.

**The missing on-ramp for AI agents on Midnight:** policy-gated, audit-logged
unshielded signing, plus an on-chain zero-knowledge proof that the audit log
*extends correctly* from its last anchor.

> TEE co-location is in progress. This repo does **not** claim TEE-backed
> signing — the sidecar does not yet run inside an attested enclave.

## Two tracks

| Track | What it does | Status |
| --- | --- | --- |
| **A — Intents signing** | Unshielded NIGHT transfers on Preprod through 1Claw's Intents API: guardrails, spend caps, hash-chained audit log. No proof server on the signing path. | **Sidecar live, 19 tests; awaiting faucet funds** |
| **B — Audit anchor** | A Compact contract that anchors 1Claw's audit chain head on Midnight, proving correct extension without revealing events, the head, or the agent's identity. | **Compiles + 12 simulator tests pass** |

The tracks are independent in Wave 1: the signer never calls the contract.

## What the proof actually claims

A naive anchor ("I know the preimage of a hash I chose") proves nothing — the
caller picks both sides, and anyone could squat any agent id. Here the chain
relation lives **inside the circuit**:

```
assert ownerTag(secretKey)  == owners[agentCommitment]      // caller owns this agent
assert headTag(prevHead)    == commitments[agentCommitment] // prevHead is the anchored one
head := fold(prevHead, newEventHashes[0..count])            // folded in circuit
commitments[agentCommitment] := headTag(head); epochs++
```

The commitment can therefore only advance by a **correct extension of the real
chain, by its real owner**.

Three things stay private: the audit events, the chain head, and the agent's
identity — map keys are `persistentHash(agentId ‖ registrationSalt)`, and the
salt never leaves the 1Claw vault.

## Quickstart (judges — no 1Claw checkout needed)

```bash
git clone https://github.com/1clawAI/midnight.git && cd midnight
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | sh
export PATH="$HOME/.local/bin:$PATH"
compact update 0.31.1          # Preprod-compatible; see version pinning below

cd contracts/audit-anchor
npm install
npm run ci                     # compile → typecheck → 12 simulator tests
```

## Version pinning (this bit matters)

`compact update` with no argument installs the newest toolchain, which currently
targets **ledger 9** and will not deploy to Preprod. Pin deliberately:

| Component | Pinned | Why |
| --- | --- | --- |
| Compact toolchain | **0.31.1** | Preprod compatibility matrix |
| Compact runtime | **0.16.0** | must match the compiler's runtime version |
| Ledger | 8.0.2 | what the 0.31.1 compiler targets |
| Proof server | **8.1.0** | matrix-specified for Preprod (Track B only) |

Source: [Midnight compatibility matrix](https://docs.midnight.network/relnotes/support-matrix).

## Layout

```
contracts/audit-anchor/          # Track B — the Compact contract
  src/AuditAnchor.compact
  src/witnesses.ts               # private state + witness functions
  src/test/                      # 12 tests against the compiled circuits
packages/midnight-signer/        # Track A — HTTP sidecar the Vault calls
  src/{validate,wallet-pool,routes,server}.ts
  src/test/                      # 19 tests
demo/anchor-viewer/              # read-only UI over the deployed contract
  src/anchor.ts                  # decode + offline verify (8 tests)
scripts/
  sync-wallets-preprod.ts        # derive + watch the two Phase 0 wallets
  deploy-anchor.sh               # compile, prove, deploy, write viewer config
```

## Running it

```bash
npm run sync-wallets     # derive both wallets, print addresses to fund
npm run deploy:anchor    # after funding: compile + deploy, writes viewer config
npm run viewer           # browse anchors, verify a fold offline
npm --workspace @1claw/midnight-signer run start   # sidecar on :8091
```

The off-chain fold helper calls the compiled contract's own `pureCircuits.foldStep`
rather than reimplementing `persistentHash` encoding — the circuit is the single
source of truth, so the two cannot drift.

## Ecosystem attribution

Built on and learned from:

- [Midnight Network documentation](https://docs.midnight.network/)
- [`midnightntwrk/example-bboard`](https://github.com/midnightntwrk/example-bboard) — the simulator + witness pattern this repo follows
- [`midnightntwrk/example-counter`](https://github.com/midnightntwrk/example-counter)
- [`midnightntwrk/compact`](https://github.com/midnightntwrk/compact) — toolchain
- `@midnight-ntwrk/compact-runtime`, `@midnight-ntwrk/midnight-js-*`, Midnight wallet SDK
- [1Claw](https://1claw.co) — vault, Intents API, and the hash-chained audit log being anchored ([docs](https://docs.1claw.co), [for AI](https://1claw.co/for-ai))

## License

Apache-2.0. 1Claw's own `vault/` and `shroud/` are separate and not covered here;
this repo imports nothing from them and is cloneable standalone.
