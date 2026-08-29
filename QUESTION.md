<!--
Copyright (C) 2026 1Claw
SPDX-License-Identifier: Apache-2.0

Drafted for the Midnight Discord / forum. Kept in the repo so the question and
the evidence behind it stay together.
-->

# Preprod: how do you register a *seed-derived* wallet for DUST generation?

**Short version:** the wallet the SDK builds and the wallet Lace registers appear
to be different wallets, and only Lace can register. So the wallet that can pay
fees isn't one `deployContract` can drive.

## What we're doing

Deploying a Compact contract to Preprod with `@midnight-ntwrk/midnight-js-contracts@4.1.1`,
`@midnight-ntwrk/wallet@4.0.0`, `wallet-sdk-hd@3.0.2`, proof server
`9.0.0-rc.7`, `language_version 0.23`. Contract compiles, 12 simulator tests
pass. The blocker is entirely fees.

## What we found

**1. Faucet NIGHT arrives unregistered.** Every unshielded UTXO carries
`registeredForDustGeneration`, and a fresh Preprod grant has it `false`:

```
mn_addr_preprod1rvf6kca…  NIGHT 5,000  UTXOs 1  (0 registered)
```

**2. Registration works through Lace, and only Lace.** Generate tDUST →
confirmed on-chain, one UTXO flipped to `registered: true`. We found no
programmatic path: `@midnight-ntwrk/wallet@5.0.0` exposes no DUST surface, and
`@midnight-ntwrk/ledger@4.0.0` is 1,995 lines of type definitions with zero
occurrences of "dust". `dustGenerationStatus` takes Cardano reward addresses and
rejects a Midnight address (`invalid HRP for Cardano reward address`).

**3. Lace and `HDWallet.fromSeed` derive different wallets from the same
24-word phrase.**

```
HDWallet.fromSeed  mn_addr_preprod1rvf6kcas7k42n5s7qslxstqzae0wwv4ljhudgaszkhdgzzx7jmqqf8apt2
Lace (same phrase) mn_addr_preprod1rarjrl25qlta4f3hrjgp6hyxvxzyrr28zuhktj8xermshunn3d8suvce3v
```

We searched for the mapping and did not find it — four seed interpretations
(BIP39 entropy, the 64-byte BIP39 seed, both halves of it) × accounts 0–3 × all
five `Roles` × indices 0–3, so 320 derivations, plus seven Cardano Icarus and
hash-based seed transforms. Network selection is ruled out: the HRP changes the
prefix and never the payload, verified across `preprod`, `test`, `dev` and
`undeployed`.

**4. The wallet SDK is seed-only.** `WalletBuilder.build`, `.buildFromSeed` and
`.restore` all take `seed: string`. Lace exposes a coin key and an encryption
key, but there's no supported way to construct a `Wallet` from those, so we
can't drive Lace's account from Node either.

## The question

**What's the intended flow for registering a wallet built by
`WalletBuilder.buildFromSeed` for DUST generation on Preprod?**

Concretely, any one of these unblocks us:

1. A programmatic registration call we've missed — an API, a transaction type,
   or an intent we should be constructing.
2. The derivation Lace uses from a 24-word phrase, so we can compute the same
   seed and hand it to `buildFromSeed`.
3. A way to build a `Wallet` from Lace's exported coin + encryption keys.
4. A Preprod DUST faucet, or a way to have the faucet issue registered NIGHT.

If the answer is "this isn't supported yet on Preprod", that's a fine answer —
we'd just like to stop looking, and it seems worth documenting, since anyone
deploying from CI or a server rather than a browser extension hits the same wall.

Happy to provide addresses, transaction hashes, or a reproduction repo. Our
work is Apache-2.0 at <https://github.com/1clawAI/midnight> — `scripts/check-dust-registration.ts`
reproduces finding 1 in one command.
