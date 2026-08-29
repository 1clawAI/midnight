// Copyright (C) 2026 1Claw
// SPDX-License-Identifier: Apache-2.0

/**
 * Derive the *unshielded* NIGHT address for a seed.
 *
 * This exists because the faucet rejects shielded addresses, and none of the
 * wallet SDK surfaces an unshielded one: `WalletState` is Zswap-only in both
 * the 4.x and 5.x generations, exposing `address` (mn_shield-addr_…) and
 * nothing else. The unshielded key lives on the HD tree under
 * Roles.NightExternal and has to be bech32m-encoded separately.
 *
 * Note the HRP is `preprod`, not `testnet`, even though Preprod runs under the
 * TestNet network id — the two are encoded independently, and the faucet
 * matches on the HRP.
 */
import { HDWallet, Roles } from "@midnight-ntwrk/wallet-sdk-hd";
import { UnshieldedAddress } from "@midnight-ntwrk/wallet-sdk-address-format";

/** Bech32m HRP for Preprod unshielded addresses. */
export const PREPROD_HRP = "preprod";

export function unshieldedAddressForSeed(seedHex: string, hrp = PREPROD_HRP): string {
  const seed = Uint8Array.from(Buffer.from(seedHex, "hex"));
  const res = HDWallet.fromSeed(seed);
  const hd = (res as { hdWallet?: unknown }).hdWallet;
  if (!hd) throw new Error("could not derive an HD wallet from that seed");

  const derived = (hd as { selectAccount(i: number): { selectRole(r: number): { deriveKeyAt(i: number): unknown } } })
    .selectAccount(0)
    .selectRole(Roles.NightExternal)
    .deriveKeyAt(0);

  const raw = (derived as { key?: Uint8Array }).key ?? (derived as unknown as Uint8Array);
  // Copy through a plain byte view: the derived key may be backed by a shared
  // buffer, and Buffer.from(ArrayBuffer) would alias it rather than copy.
  const bytes = Buffer.from(Uint8Array.from(raw));
  if (bytes.length !== UnshieldedAddress.keyLength) {
    throw new Error(`expected ${UnshieldedAddress.keyLength} key bytes, got ${bytes.length}`);
  }

  return UnshieldedAddress.codec.encode(hrp, new UnshieldedAddress(bytes)).toString();
}
