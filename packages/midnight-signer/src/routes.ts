// Copyright (C) 2026 1Claw
// SPDX-License-Identifier: Apache-2.0

import { nativeToken } from "@midnight-ntwrk/zswap";
import { CFG } from "./config.js";
import { acquire, firstState, poolSize } from "./wallet-pool.js";
import { addressOf, publicKeyOf, splitBalances, hasSpendableCoins } from "./night.js";
import { unshieldedNight } from "./unshielded.js";
import { unshieldedAddressFor } from "./derive-unshielded.js";
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
  const state = await firstState(entry);
  const { dust } = splitBalances(state);

  // NIGHT is read from the indexer, not the wallet. Faucet NIGHT lands in the
  // *unshielded* UTXO set, which WalletState does not cover — reading it from
  // `balances` reported zero for a funded wallet.
  const unshieldedAddr = unshieldedAddressFor(seed);
  const night = await unshieldedNight(unshieldedAddr).catch(() => null);

  return {
    night_base_units: night?.nightBaseUnits ?? "0",
    dust_base_units: dust,
    address: addressOf(state),
    unshielded_address: unshieldedAddr,
    night_source: night ? "indexer" : "unavailable",
    night_transactions: night?.transactions ?? 0,
  };
}

/** Everything the dry-run decision needs, with no network or wallet in it. */
export interface DryRunFacts {
  nightBaseUnits: string;
  dustBaseUnits: string;
  hasCoins: boolean;
  amountBaseUnits: bigint;
  unshieldedAddress: string;
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

  if (night === 0n) {
    problems.push(
      `no unshielded NIGHT at ${f.unshieldedAddress} — fund that address at the Preprod faucet`,
    );
  } else if (night < f.amountBaseUnits) {
    problems.push(`insufficient NIGHT: have ${f.nightBaseUnits}, need ${String(f.amountBaseUnits)}`);
  }

  if (!f.hasCoins) {
    // Distinct from "unfunded": the shielded wallet is genuinely empty even when
    // unshielded NIGHT is present, because the two live in separate ledgers.
    problems.push("no shielded (Zswap) coins — unshielded NIGHT cannot be spent by the shielded wallet");
  }

  if (BigInt(f.dustBaseUnits || "0") <= 0n) {
    // The failure people hit most: NIGHT present, DUST not yet accrued.
    problems.push("no DUST — fees are paid in DUST, which accrues from held NIGHT over time");
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
  const state = await firstState(entry);
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
  };
}

/** POST /v1/build-and-sign */
export async function buildAndSign(body: Json): Promise<Json> {
  const seed = requireSeed(body.seed_hex);
  requireNetwork(body.network);
  const to = requireAddress(body.to_address);
  const amount = requireAmountBaseUnits(body.amount_base_units);
  const broadcast = requireBoolean(body.broadcast, "broadcast", true);

  const entry = await acquire(seed);
  const state = await firstState(entry);

  // Fail before proving rather than after. Proving is the expensive step and an
  // unfunded wallet is the common case during Preprod bring-up.
  if (!hasSpendableCoins(state)) {
    throw new PreconditionError(
      "wallet has no spendable UTXOs — fund it from the Preprod faucet and wait for DUST",
    );
  }

  const from = addressOf(state);
  const { wallet } = entry;

  const recipe = await wallet.transferTransaction([
    { amount, receiverAddress: to, type: nativeToken() } as never,
  ]);
  const proven = await wallet.proveTransaction(recipe);

  if (!broadcast) {
    return {
      tx_hash: "",
      raw_tx: String(proven),
      from_address: from,
      status: "signed",
    };
  }

  const txId = await wallet.submitTransaction(proven);
  return {
    tx_hash: String(txId),
    raw_tx: String(proven),
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
