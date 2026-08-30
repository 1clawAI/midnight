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
| **A — Intents signing** | Unshielded NIGHT transfers on Preprod through 1Claw's Intents API: guardrails, spend caps, hash-chained audit log. No proof server on the signing path. | **Sidecar live, 36 tests; wallet funded and generating DUST** |
| **B — Audit anchor** | A Compact contract that anchors 1Claw's audit chain head on Midnight, proving correct extension without revealing events, the head, or the agent's identity. | **Compiles + 12 simulator tests pass; viewer live** |

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

**[DEMO.md](DEMO.md)** — a 3-minute run sheet with reproducible steps.

**Live viewer:** <https://1claw-anchor-viewer.vercel.app> — reads the anchored
ledger, and verifies a fold offline using the contract's own circuit even before
a contract address is configured.

**Deployed contract (Preprod):**
`ba10cd4ac487b7a470f00ab6509295ea0673cdc5a26a866948c7bc2657fc2c86`

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
2. **Register the NIGHT for DUST generation.** Holding NIGHT alone produces
   nothing, and DUST — not NIGHT — is what pays fees. This is the step that
   catches people out: a wallet looks funded and still cannot transact.

   The faucet hands out *unregistered* NIGHT. Every unshielded UTXO carries a
   `registeredForDustGeneration` flag, and on a fresh faucet grant it is
   `false`. Check yours:

   ```
   npx tsx scripts/check-dust-registration.ts
   ```

   Registration is backed by a **Cardano** UTXO — the indexer's
   `DustRegistration` keys on `utxoTxHash` / `utxoOutputIndex`, both documented
   as Cardano fields, and `dustGenerationStatus` takes Cardano reward addresses
   and rejects a Midnight one. Nothing in this repo can perform it, and neither
   the Midnight faucet page nor the installed wallet SDK exposes it.
3. Once `check-dust-registration` reports *generating*, run
   `scripts/watch-dust-and-deploy.sh` — it waits for DUST, deploys the anchor,
   and publishes the viewer.

`npm --workspace @1claw/midnight-signer run start` then answers `/v1/dry-run`
with exactly which of those three is missing.

## Getting DUST on Preprod (this catches everyone)

DUST pays fees, and faucet NIGHT does not generate it. Every unshielded UTXO
carries `registeredForDustGeneration`, and a fresh faucet grant has it `false`.
A wallet can look funded and be unable to transact.

```bash
npx tsx scripts/check-dust-registration.ts   # is this NIGHT generating?
npx tsx scripts/register-dust.ts             # register it (proof server on :6300)
npx tsx scripts/check-dust-registration.ts   # expect: generating
```

`register-dust.ts` builds the wallet facade, waits for sync, selects the
unregistered coins and submits `registerNightUtxosForDustGeneration` →
`finalizeRecipe` → `submitTransaction` — the same transaction Lace's
**Generate tDUST** button sends, from a seed you control, so the wallet that
ends up able to pay fees is also the one `deploy-anchor.sh` drives.

**The first registration pays for itself.** A wallet with zero DUST can still
submit its own registration: NIGHT accrues DUST retroactively from the UTXO's
creation time, so the fee is covered by generation that has already happened.
There is no airdrop step and no chicken-and-egg. Verified on Preprod — a wallet
holding 5,000 NIGHT and no DUST registered itself and came back with 356 DUST.

The sync is the slow part: allow roughly an hour on a cold wallet. Both scripts
print progress every 20 seconds, so a stall is visible rather than looking like
patience.

### Three things that cost us a day, recorded so they cost you nothing

**The registration API is in a different npm scope.**
`@midnightntwrk/wallet-sdk` — no hyphen — is not the same package as
`@midnight-ntwrk/wallet`. The DUST surface lives only in the former. We searched
the hyphenated scope, found nothing, and concluded no registration API existed
anywhere. It does. Every other item here is downstream of that one character.

**Do not hand-roll the unshielded address.** We derived the key correctly under
`Roles.NightExternal` and then bech32m-encoded those bytes directly. The key
bytes matched the SDK exactly; the address did not. We faucet-funded an address
the SDK never derives, then spent a long time concluding the toolchain and Lace
disagreed about derivation — when only our own encoder did. Use
`createKeystore(key, networkId).getBech32Address()`, which is what both the SDK
and Lace use.

**`WalletBuilder` cannot pay a fee.** The builder in `@midnight-ntwrk/wallet` is
Zswap-only: it reports `coins: 0` for a wallet holding unshielded NIGHT, and
then fails with `expected instance of LedgerParameters` because it cannot
assemble a fee-paying transaction without the DUST wallet. That error names the
symptom, not the cause. Use `WalletFacade`, which carries all three wallets —
shielded, unshielded and dust. It balances into a *recipe* which you then
finalize, rather than exposing a single `balanceTransaction`.

**And two network identifiers that disagree.** `midnight-js` keeps a string and
wants `"preprod"`; `zswap`'s `NetworkId` enum has no Preprod variant, so the
wallet takes `TestNet`. Both are needed, and setting the first to `"test"`
silently encodes addresses under the wrong HRP and finds no coins.

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
npm ci

# Tests — no account, no funds, no network needed
cd contracts/audit-anchor       && npm test   # 12 simulator tests
cd ../../packages/midnight-signer && npm test # 36 sidecar tests
cd ../../demo/anchor-viewer       && npm test # 8 viewer tests

# Preprod, in order. Each step needs the previous one.
npx tsx scripts/sync-wallets-preprod.ts       # derive + print the faucet address
#   fund it at https://faucet.preprod.midnight.network/
npx tsx scripts/check-dust-registration.ts    # expect: not generating
npx tsx scripts/register-dust.ts              # proof server on :6300
npx tsx scripts/check-dust-registration.ts    # expect: generating
bash scripts/deploy-anchor.sh                 # deploys, writes the viewer config

# Or leave it unattended once the wallet is registered:
bash scripts/watch-dust-and-deploy.sh         # waits for DUST, deploys, publishes
```

The proof server is required for anything that proves a circuit — registration
and deployment both do:

```bash
docker run -d -p 6300:6300 midnightntwrk/proof-server:8.1.0-arm64 \
  -- midnight-proof-server --network preprod
```

## Ecosystem attribution

This repo would not exist without the following, and several of them solved
problems we could not have solved from the docs alone.

**Documentation and tooling**

- [Midnight Network documentation](https://docs.midnight.network/) — the
  language reference for Compact, and the DUST/NIGHT model that governs
  everything about funding a Preprod wallet.
- [`midnightntwrk/midnight-node-docker`](https://github.com/midnightntwrk/midnight-node-docker)
  — local-dev images. The proof server (`proof-server:8.1.0`) runs from here;
  deployment proves a circuit and cannot work without it. Pin it to the version
  in the [support matrix](https://docs.midnight.network/relnotes/support-matrix)
  for the target network — 8.1.0 alongside Midnight.js 4.1.1 and Wallet SDK
  1.2.0 on Preprod. A newer server still proves, and the node then rejects the
  DUST fee proof at submission as `Custom error: 170`, which names neither the
  proof server nor the version.
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
