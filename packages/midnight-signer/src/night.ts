// Copyright (C) 2026 1Claw
// SPDX-License-Identifier: Apache-2.0

import { unshieldedToken } from "@midnight-ntwrk/midnight-js-protocol/ledger";
import { MidnightBech32m } from "@midnightntwrk/wallet-sdk";
import { getNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import type { WalletState } from "./wallet-pool.js";

/**
 * Balance extraction from a FacadeState.
 *
 * NIGHT and DUST live in different sub-wallets and neither is a key in one
 * `balances` map. NIGHT held from the faucet is an *unshielded* UTXO balance;
 * DUST is not a token balance at all but a value derived from registered NIGHT
 * and elapsed time, which is why it takes a timestamp to read.
 *
 * That distinction is the whole reason they are reported separately: a wallet
 * can hold plenty of NIGHT and still be unable to transact, because fees are
 * paid in DUST and NIGHT only generates DUST once registered.
 *
 * Under the previous Zswap-only wallet none of this was reachable — DUST was
 * guessed as "the non-native token, else 0", which always produced 0 and
 * presented it as a measurement.
 */

type FacadeShape = {
  unshielded?: { balances?: Record<string, unknown>; availableCoins?: readonly unknown[] };
  shielded?: { address?: unknown; availableCoins?: readonly unknown[] };
  dust?: { balance?: (at: Date) => bigint };
  isSynced?: boolean;
};

const view = (state: WalletState): FacadeShape => state as unknown as FacadeShape;

export function splitBalances(state: WalletState): {
  night: string;
  dust: string | null;
  raw: Record<string, string>;
} {
  const s = view(state);

  const balances = (s.unshielded?.balances ?? {}) as Record<string, unknown>;
  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(balances)) raw[k] = String(v ?? "0");

  const night = raw[unshieldedToken().raw] ?? "0";

  // `null` when the sub-wallet is absent, so a caller can still tell "none"
  // from "cannot tell" if the facade is ever built without a DustWallet.
  const dust = s.dust?.balance ? String(s.dust.balance(new Date())) : null;

  return { night, dust, raw };
}

/**
 * The shielded address, bech32m-encoded.
 *
 * `ShieldedAddress` is a structured object with no meaningful `toString`, so
 * interpolating it yields "[object Object]" — which is exactly what this
 * endpoint returned as an address until the encoder below was used.
 */
export function addressOf(state: WalletState): string {
  const a = view(state).shielded?.address;
  if (a == null) throw new Error("wallet state has no shielded address");
  return MidnightBech32m.encode(getNetworkId() as never, a as never).asString();
}

/** Hex coin public key. `coinPublicKeyString` is a method, not a property. */
export function publicKeyOf(state: WalletState): string {
  const a = view(state).shielded?.address as { coinPublicKeyString?: () => string } | undefined;
  const str = typeof a?.coinPublicKeyString === "function" ? a.coinPublicKeyString() : "";
  if (!str) throw new Error("wallet state has no coin public key");
  return str;
}

/**
 * Spendable *unshielded* UTXOs — what an unshielded transfer draws on.
 *
 * Deliberately not the shielded set: this signer only builds unshielded
 * transfers, and holding unshielded NIGHT while the shielded wallet is empty is
 * the normal state here, not a fault worth reporting.
 */
export function hasSpendableCoins(state: WalletState): boolean {
  return (view(state).unshielded?.availableCoins ?? []).length > 0;
}
