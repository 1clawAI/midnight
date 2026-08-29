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

/** Heuristic: DUST is the non-native token the wallet reports, if any. */
export function splitBalances(state: WalletState): {
  night: string;
  dust: string;
  raw: Record<string, string>;
} {
  const balances = (state.balances ?? {}) as Record<string, unknown>;
  const raw: Record<string, string> = {};
  for (const [k, v] of Object.entries(balances)) raw[k] = String(v ?? "0");

  const nightKey = NIGHT_TOKEN();
  const night = raw[nightKey] ?? "0";

  // Anything that is not the native token and looks like a balance is treated
  // as DUST. Reported as "0" rather than guessed when absent, so a caller can
  // tell "no DUST" from "unknown".
  const dustEntry = Object.entries(raw).find(([k]) => k !== nightKey);
  const dust = dustEntry ? dustEntry[1] : "0";

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
