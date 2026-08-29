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

**Live viewer:** <https://1claw-anchor-viewer.vercel.app> — reads the anchored
ledger, and verifies a fold offline using the contract's own circuit even before
a contract address is configured.

For the threat model, why the obvious designs fail, what the proof does *not*
claim, and the privacy analysis, see **[WHITEPAPER.md](WHITEPAPER.md)**.

## Quickstart (judges — no 1Claw checkout needed)

```bash
git clone https://github.com/1clawAI/midnight.git && cd midnight
curl --proto '=https' --tlsv1.2 -LsSf \
  https://github.com/midnightntwrk/compact/releases/latest/download/compact-installer.sh | sh
export PATH="$HOME/.local/bin:$PATH"
compact update 0.34            # ledger 9 — see version pinning below

cd contracts/audit-anchor
npm install
npm run ci                     # compile → typecheck → 12 simulator tests
```

## Funding a Preprod wallet

`npm run sync-wallets` prints two addresses per wallet. They are not
interchangeable:

| Address | Looks like | Use |
| --- | --- | --- |
| **Unshielded** | `mn_addr_preprod1…` | **the faucet** — it rejects shielded addresses |
| Shielded | `mn_shield-addr_test1…` | what the wallet SDK reports and transacts with |

Only the shielded one appears in `WalletState`; the unshielded key lives on the
HD tree under `Roles.NightExternal` and is bech32m-encoded separately
(`scripts/unshielded-address.ts`). Note the HRP is `preprod` even though Preprod
runs under the **TestNet** network id — the two are encoded independently.

1. Request tNIGHT at <https://faucet.preprod.midnight.network/> using the
   **unshielded** address. Rate limited; ~1000 tNIGHT per request.
2. **Register the NIGHT on-chain** to start DUST generating. Holding NIGHT alone
   produces nothing, and DUST — not NIGHT — is what pays fees. This is the step
   that catches people out: a wallet can look funded and still be unable to
   transact.
3. Wait for DUST to accrue, then `npm run deploy:anchor`.

`npm --workspace @1claw/midnight-signer run start` then answers `/v1/dry-run`
with exactly which of those three is missing.

## Version pinning (this bit matters)

`compact update` with no argument installs the newest toolchain, which currently
targets **ledger 9** and will not deploy to Preprod. Pin deliberately:

| Component | Pinned | Why |
| --- | --- | --- |
| Compact toolchain | **0.31.1** | what midnightntwrk/example-bboard pins for Preprod |
| Compact runtime | **0.16.0** | must match the compiler's runtime version |
| Ledger | 8.0.2 | what the 0.31.1 compiler targets |
| Wallet SDK | **4.0.0** / zswap **3.0.6** | the ledger-8 pairing |
| midnight-js | **4.1.1** | latest stable; 5.x is beta only |
| Proof server | **8.1.0** | matrix-specified for Preprod (Track B only) |

We tried ledger 9 (toolchain 0.34 / wallet 5 / zswap 4) because Preprod serves
`unshieldedCreatedOutputs`, `dustLedgerEvents` and `dustGenerationStatus`, and a
faucet payout arrives as unshielded NIGHT — all ledger-9 concepts. It was the
wrong conclusion: midnight-js has no stable ledger-9 release (5.0.0-beta.7 only,
on an Effect-based API), and the actively maintained example-bboard still pins
ledger-v8 8.1.0 with midnight-js 4.1.1. Preprod evidently serves the newer
indexer surface over a ledger-8 chain.

Two things that cost time on 0.34, in case anyone tries again:

- `event` became a reserved word in language 0.26.
- `Contract.initialState` and the impure circuits became async, and
  `CircuitContext` turned into a call-tree built by `createCircuitContext`.


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

This repo would not exist without the following, and several of them solved
problems we could not have solved from the docs alone.

**Documentation and tooling**

- [Midnight Network documentation](https://docs.midnight.network/) — the
  language reference for Compact, and the DUST/NIGHT model that governs
  everything about funding a Preprod wallet.
- [`midnightntwrk/midnight-node-docker`](https://github.com/midnightntwrk/midnight-node-docker)
  — local-dev images. The proof server (`proof-server:9.0.0-rc.7`) runs from
  here; deployment proves a circuit and cannot work without it.
- [`midnightntwrk/compact`](https://github.com/midnightntwrk/compact) — the
  compiler that produces `managed/`, the `.zkir` and the verifier keys.

**Reference implementations we read closely**

- [`midnightntwrk/example-bboard`](https://github.com/midnightntwrk/example-bboard)
  — the witness + `QueryContext` simulator pattern our contract tests follow.
  Our `AuditAnchorSimulator` is a direct descendant. Checking our toolchain
  versions against a working reference is also what led us to revert an
  attempted ledger 9 upgrade and stay on the v8 line.
- [`midnightntwrk/example-counter`](https://github.com/midnightntwrk/example-counter)
  — the smallest complete deploy-and-call loop, and the clearest illustration
  of provider wiring.
- [`mashharuki/midnight-sample-fullstack-app`](https://github.com/mashharuki/midnight-sample-fullstack-app)
  — a community full-stack sample showing contract, wallet and frontend fitting
  together, which the official examples deliberately keep separate. The same
  author's [`midnight-awesome-dapps`](https://github.com/mashharuki/midnight-awesome-dapps)
  was the fastest way to find working code for a given problem.

**Packages**

- `@midnight-ntwrk/compact-runtime` — circuit execution and the ledger types
  the simulator asserts against.
- `@midnight-ntwrk/midnight-js-*` (contracts, providers, network-id) —
  deployment and the indexer/proof/private-state providers.
- `@midnight-ntwrk/wallet` and `@midnight-ntwrk/zswap` — wallet construction
  and the shielded balance model.
- `@midnight-ntwrk/wallet-sdk-hd` and
  `@midnight-ntwrk/wallet-sdk-address-format` — **the two that unblocked this
  project.** No wallet SDK surface exposes an unshielded address: `WalletState`
  is Zswap-only in both the 4.x and 5.x generations, so it reports zero for a
  wallet the faucet has funded. The unshielded key has to be derived from the
  HD tree under `Roles.NightExternal` and bech32m-encoded separately, with the
  `preprod` HRP rather than `testnet`. `scripts/unshielded-address.ts` is that,
  and it is the reason anything here can be funded at all.

**Platform**

- [1Claw](https://1claw.co) — the vault, Intents API and hash-chained audit log
  this contract anchors. ([docs](https://docs.1claw.co) ·
  [for AI agents](https://1claw.co/for-ai))

## License

Apache-2.0. 1Claw's own `vault/` and `shroud/` are separate and not covered here;
this repo imports nothing from them and is cloneable standalone.
