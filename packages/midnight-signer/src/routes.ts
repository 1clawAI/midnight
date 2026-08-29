// Copyright (C) 2026 1Claw
// SPDX-License-Identifier: Apache-2.0

import { nativeToken } from "@midnight-ntwrk/zswap";
import { CFG } from "./config.js";
import { acquire, firstState, poolSize } from "./wallet-pool.js";
import { addressOf, publicKeyOf, splitBalances, hasSpendableCoins } from "./night.js";
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
  const { night, dust } = splitBalances(state);

  return { night_base_units: night, dust_base_units: dust, address: addressOf(state) };
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
  const { night, dust } = splitBalances(state);

  const problems: string[] = [];
  if (!hasSpendableCoins(state)) {
    problems.push("wallet has no spendable UTXOs — fund it from the Preprod faucet");
  }
  if (BigInt(night || "0") < amount) {
    problems.push(`insufficient NIGHT: have ${night}, need ${String(amount)}`);
  }
  if (BigInt(dust || "0") <= 0n) {
    // The failure people hit most: NIGHT present, DUST not yet accrued.
    problems.push("no DUST — fees are paid in DUST, which accrues from held NIGHT over time");
  }

  return {
    ok: problems.length === 0,
    problems,
    from_address: addressOf(state),
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
