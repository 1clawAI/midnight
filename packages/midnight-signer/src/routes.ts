// Copyright (C) 2026 1Claw
// SPDX-License-Identifier: Apache-2.0

import { nativeToken } from "@midnight-ntwrk/zswap";
import { CFG } from "./config.js";
import { acquire, firstState, markSpent, syncedState, poolSize } from "./wallet-pool.js";
import { addressOf, publicKeyOf, splitBalances, hasSpendableCoins } from "./night.js";
import { unshieldedNight } from "./unshielded.js";
import { unshieldedAddressFor } from "./derive-unshielded.js";
import { MidnightBech32m, UnshieldedAddress } from "@midnightntwrk/wallet-sdk";
import { unshieldedToken } from "@midnight-ntwrk/midnight-js-protocol/ledger";
import { getNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import {
  requireSeed,
  requireNetwork,
  requireAddress,
  requireAmountBaseUnits,
  requireBoolean,
  ValidationError,
} from "./validate.js";

/** Raised for conditions the caller can act on (unfunded wallet, no DUST). */
export class PreconditionError extends Error {}

export type Json = Record<string, unknown>;

/** POST /v1/derive-address */
export async function deriveAddress(body: Json): Promise<Json> {
  const seed = requireSeed(body.seed_hex);
  requireNetwork(body.network);

  const entry = await acquire(seed);
  const state = await firstState(entry);

  return { address: addressOf(state), public_key_hex: publicKeyOf(state) };
}

/** POST /v1/balance */
export async function balance(body: Json): Promise<Json> {
  requireNetwork(body.network);
  // Balances are per-wallet, so a seed is required even though the Rust client
  // calls this with an address: the indexer cannot report a wallet's spendable
  // set from an address alone.
  const seed = requireSeed(body.seed_hex);

  const entry = await acquire(seed);
  const { state, synced } = await syncedState(entry);
  const { dust } = splitBalances(state);

  // NIGHT is read from the indexer rather than the wallet. The facade's
  // unshielded sub-wallet does now report it (the Zswap-only wallet did not,
  // which is why this path exists), but the indexer also supplies the
  // transaction count below and the two agree, so it stays the source here.
  const unshieldedAddr = unshieldedAddressFor(seed);
  const night = await unshieldedNight(unshieldedAddr).catch(() => null);

  return {
    night_base_units: night?.nightBaseUnits ?? "0",
    // Qualified by `synced`: until the wallet catches up this is the
    // checkpoint's stale figure, not what the wallet holds now.
    dust_base_units: dust,
    synced,
    address: addressOf(state),
    unshielded_address: unshieldedAddr,
    night_source: night ? "indexer" : "unavailable",
    night_transactions: night?.transactions ?? 0,
  };
}

/** Everything the dry-run decision needs, with no network or wallet in it. */
export interface DryRunFacts {
  nightBaseUnits: string;
  dustBaseUnits: string | null;
  hasCoins: boolean;
  amountBaseUnits: bigint;
  unshieldedAddress: string;
  /** False while the wallet is still catching up, which makes the rest stale. */
  synced: boolean;
}

/**
 * Decide why a transfer would fail, given already-fetched facts.
 *
 * Pure, and separate from `dryRun` so the failure paths are testable at all:
 * the interesting cases — no DUST, no UTXOs, not enough NIGHT — are on-chain
 * states that cannot be produced on demand against a live Preprod wallet, so
 * the only way to cover them is to hand the decision its inputs directly.
 *
 * Every problem is collected rather than returning on the first: a caller
 * funding a new wallet wants to know it needs both NIGHT and DUST in one round
 * trip, not to discover the second after fixing the first.
 */
export function collectDryRunProblems(f: DryRunFacts): string[] {
  const problems: string[] = [];
  const night = BigInt(f.nightBaseUnits || "0");

  // First, because it changes what every other line here is worth: an unsynced
  // wallet reports a stale tip, so a clean dry-run against it would be a
  // prediction about the past.
  if (!f.synced) {
    problems.push(
      "wallet is still catching up — balances below are from the last checkpoint, not current",
    );
  }

  if (night === 0n) {
    problems.push(
      `no unshielded NIGHT at ${f.unshieldedAddress} — fund that address at the Preprod faucet`,
    );
  } else if (night < f.amountBaseUnits) {
    problems.push(`insufficient NIGHT: have ${f.nightBaseUnits}, need ${String(f.amountBaseUnits)}`);
  }

  if (!f.hasCoins) {
    // The unshielded UTXO set, which is what an unshielded transfer spends.
    // This used to report the *shielded* set being empty, which is both the
    // wrong ledger for this transfer and the normal state of this wallet.
    problems.push(
      `no spendable unshielded UTXOs at ${f.unshieldedAddress} — fund it at the Preprod faucet`,
    );
  }

  if (f.dustBaseUnits === null) {
    // Should not happen now that the facade always carries a DustWallet; it
    // means the wallet was built without one, which is a fault in this process
    // rather than a statement about the wallet's funding.
    problems.push(
      "DUST balance not observable — the wallet was built without a DustWallet; this is a signer fault",
    );
  } else if (BigInt(f.dustBaseUnits) <= 0n) {
    // A real measurement of zero, once something can measure it.
    problems.push(
      "no DUST — fees are paid in DUST, and this NIGHT is not registered to generate it; " +
        "run scripts/check-dust-registration.ts",
    );
  }

  return problems;
}

/**
 * POST /v1/dry-run
 *
 * Checks everything that can be checked without producing a signature, so a
 * caller can distinguish "this would fail" from "this failed halfway".
 */
export async function dryRun(body: Json): Promise<Json> {
  const seed = requireSeed(body.seed_hex);
  requireNetwork(body.network);
  const to = requireAddress(body.to_address);
  const amount = requireAmountBaseUnits(body.amount_base_units);

  const entry = await acquire(seed);
  const { state, synced } = await syncedState(entry);
  const { dust } = splitBalances(state);

  const unshieldedAddr = unshieldedAddressFor(seed);
  const nightInfo = await unshieldedNight(unshieldedAddr).catch(() => null);
  const night = nightInfo?.nightBaseUnits ?? "0";

  const problems = collectDryRunProblems({
    nightBaseUnits: night,
    dustBaseUnits: dust,
    hasCoins: hasSpendableCoins(state),
    amountBaseUnits: amount,
    unshieldedAddress: unshieldedAddr,
    synced,
  });

  return {
    ok: problems.length === 0,
    problems,
    from_address: addressOf(state),
    unshielded_address: unshieldedAddr,
    to_address: to,
    amount_base_units: String(amount),
    night_base_units: night,
    dust_base_units: dust,
    synced,
  };
}

/**
 * POST /v1/build-and-sign
 *
 * Note for callers using `broadcast: false`: building the transaction reserves
 * the wallet's dust coin whether or not it is ever sent, so the wallet reports
 * `dust: 0` and cannot build a second transaction until that reservation
 * clears. A dry signature is not free of side effects on this chain.
 */
export async function buildAndSign(body: Json): Promise<Json> {
  const seed = requireSeed(body.seed_hex);
  requireNetwork(body.network);
  const to = requireAddress(body.to_address);
  const amount = requireAmountBaseUnits(body.amount_base_units);
  const broadcast = requireBoolean(body.broadcast, "broadcast", true);

  const entry = await acquire(seed);
  const { state, synced } = await syncedState(entry);

  // Signing from a stale tip cannot work: fees are assembled from the DUST the
  // wallet can see, and a restored-but-not-caught-up wallet sees the
  // checkpoint's. Better to say so than to spend a proving cycle discovering it.
  if (!synced) {
    throw new PreconditionError(
      "wallet is still catching up and cannot assemble fees yet — retry once /v1/balance reports synced",
    );
  }

  // Fail before proving rather than after. Proving is the expensive step and an
  // unfunded wallet is the common case during Preprod bring-up.
  if (!hasSpendableCoins(state)) {
    throw new PreconditionError(
      "wallet has no spendable UTXOs — fund it from the Preprod faucet and wait for DUST",
    );
  }

  const from = addressOf(state);
  const { wallet, shieldedSecretKeys, dustSecretKey, unshieldedKeystore } = entry;

  // Unshielded transfer: faucet NIGHT lands in the unshielded UTXO set, which is
  // what this sidecar exists to spend. The old call built a *shielded* transfer
  // with the Zswap native token, against a wallet that could not pay a DUST fee
  // anyway.
  const receiver = MidnightBech32m.parse(to).decode(UnshieldedAddress, getNetworkId());
  // Before building, not after: the recipe reserves the dust coin the moment it
  // is created, and a checkpoint taken between here and the next emitted state
  // would persist that reservation permanently.
  markSpent(entry);

  const recipe = await wallet.transferTransaction(
    [
      {
        type: "unshielded",
        outputs: [{ type: unshieldedToken().raw, receiverAddress: receiver, amount }],
      },
    ],
    { shieldedSecretKeys, dustSecretKey },
    { ttl: new Date(Date.now() + 3_600_000), payFees: true },
  );

  // Sign the unshielded segment before finalizing. The facade balances into a
  // recipe; an unshielded intent is not bound until it carries a signature, and
  // finalizing an unbound intent fails with "Intent with id N is not bound".
  const signed = await wallet.signRecipe(recipe, (data) => unshieldedKeystore.signData(data));
  const finalized = await wallet.finalizeRecipe(signed);

  // Hex of the serialized transaction, not `String(finalized)` — that yields a
  // Rust Debug dump ("StandardTransaction { network_id: ... }"), which reads
  // like a payload but cannot be submitted or deserialized by anything.
  const rawTx = Buffer.from(finalized.serialize()).toString("hex");

  if (!broadcast) {
    return {
      // Empty because nothing was submitted. The transaction does carry a
      // transactionHash(), but it is not a submission id and the ledger docs
      // warn it cannot be used to watch for this transaction, so returning it
      // here would invite exactly that.
      tx_hash: "",
      raw_tx: rawTx,
      from_address: from,
      status: "signed",
    };
  }

  const txId = await wallet.submitTransaction(finalized);
  return {
    tx_hash: String(txId),
    raw_tx: rawTx,
    from_address: from,
    status: "broadcast",
  };
}

/** GET /healthz */
export function healthz(): Json {
  return {
    ok: true,
    network: "preprod",
    indexer: CFG.indexer,
    proof_server: CFG.proofServer,
    warm_wallets: poolSize(),
  };
}

export { ValidationError };
