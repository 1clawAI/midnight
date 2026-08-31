// Copyright (C) 2026 1Claw
// SPDX-License-Identifier: Apache-2.0

import { nativeToken } from "@midnight-ntwrk/zswap";
import type { WalletState } from "./wallet-pool.js";

/**
 * Balance extraction.
 *
 * `balances` is keyed by token type. NIGHT is the native token; DUST is a
 * distinct type that accrues from held NIGHT and is what actually pays fees —
 * which is why it is reported separately rather than folded into one number. A
 * wallet can hold plenty of NIGHT and still be unable to transact.
 */

export const NIGHT_TOKEN = (): string => String(nativeToken());

/**
 * NIGHT from the wallet's balance map, and DUST as **unknown**.
 *
 * DUST is not a token in `state.balances`. It is derived from registered NIGHT
 * and elapsed time by a DustWallet, which a WalletBuilder wallet does not have —
 * `@midnight-ntwrk/wallet` is Zswap-only, the same limitation that made
 * deploy-anchor move to WalletFacade.
 *
 * This used to guess "DUST is the non-native token, else 0", which always
 * produced 0 and presented it as fact. dryRun then reported "no DUST — this
 * NIGHT is not registered to generate it", a confident diagnosis of something
 * this process cannot observe, sending people to re-register DUST they already
 * had. Reporting null lets a caller tell "none" from "cannot tell".
 */
export function splitBalances(state: WalletState): {
  night: string;
  dust: string | null;
  raw: Record<string, string>;
} {
  const balances = (state.balances ?? {}) as Record<string, unknown>;
  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(balances)) raw[k] = String(v ?? "0");

  const nightKey = NIGHT_TOKEN();
  const night = raw[nightKey] ?? "0";

  // Null, not "0": this wallet cannot see DUST at all, and a zero here reads as
  // a measurement. `raw` still carries whatever the wallet did report, so a
  // caller that wants to inspect it can.
  const dust = null;

  return { night, dust, raw };
}

export function addressOf(state: WalletState): string {
  const a = state.address;
  if (typeof a !== "string" || !a) throw new Error("wallet state has no address");
  return a;
}

export function publicKeyOf(state: WalletState): string {
  // coinPublicKeyLegacy is the hex form; the bech32m `coinPublicKey` is the
  // display form. The Rust client stores the hex.
  const legacy = state.coinPublicKeyLegacy;
  if (typeof legacy === "string" && legacy) return legacy;
  const cpk = state.coinPublicKey;
  return typeof cpk === "string" ? cpk : "";
}

/** True once the wallet has anything spendable. */
export function hasSpendableCoins(state: WalletState): boolean {
  const coins = (state.availableCoins as unknown[] | undefined) ?? (state.coins as unknown[] | undefined) ?? [];
  return coins.length > 0;
}
