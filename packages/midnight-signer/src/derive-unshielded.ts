// Copyright (C) 2026 1Claw
// SPDX-License-Identifier: Apache-2.0

/**
 * Unshielded NIGHT address for a seed — the one the faucet accepts and the one
 * unshielded balances are keyed by. Mirrors scripts/unshielded-address.ts; kept
 * here so the sidecar has no dependency outside its own package.
 */
import { HDWallet, Roles } from "@midnight-ntwrk/wallet-sdk-hd";
import { UnshieldedAddress } from "@midnight-ntwrk/wallet-sdk-address-format";

export const PREPROD_HRP = "preprod";

export function unshieldedAddressFor(seedHex: string, hrp = PREPROD_HRP): string {
  const res = HDWallet.fromSeed(Uint8Array.from(Buffer.from(seedHex, "hex")));
  const hd = (res as { hdWallet?: unknown }).hdWallet;
  if (!hd) throw new Error("could not derive an HD wallet from that seed");

  const derived = (
    hd as { selectAccount(i: number): { selectRole(r: number): { deriveKeyAt(i: number): unknown } } }
  )
    .selectAccount(0)
    .selectRole(Roles.NightExternal)
    .deriveKeyAt(0);

  const raw = (derived as { key?: Uint8Array }).key ?? (derived as unknown as Uint8Array);
  const bytes = Buffer.from(Uint8Array.from(raw));
  return UnshieldedAddress.codec.encode(hrp, new UnshieldedAddress(bytes)).toString();
}
