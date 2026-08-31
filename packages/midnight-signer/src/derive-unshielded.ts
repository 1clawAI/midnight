// Copyright (C) 2026 1Claw
// SPDX-License-Identifier: Apache-2.0

/**
 * Unshielded NIGHT address for a seed — the one the faucet accepts and the one
 * unshielded balances are keyed by.
 *
 * This must go through `createKeystore().getBech32Address()`, the same path the
 * SDK uses internally. It previously bech32m-encoded the derived key bytes
 * directly, which produces a well-formed address that the SDK never derives —
 * so funds sent to it are stranded and the balance for the wallet you actually
 * hold reads zero.
 *
 * That exact bug is what stalled Preprod bring-up: the faucet funded an address
 * nothing could spend from. It was fixed in scripts/unshielded-address.ts and
 * left here, in the sidecar, where this function supplies the address a caller
 * would copy in order to fund the wallet. The comment above it even claimed it
 * mirrored the script; it mirrored the version before the fix.
 */
import { HDWallet, Roles } from "@midnight-ntwrk/wallet-sdk-hd";
import { createKeystore } from "@midnightntwrk/wallet-sdk-unshielded-wallet";

export const PREPROD_HRP = "preprod";

export function unshieldedAddressFor(seedHex: string, hrp = PREPROD_HRP): string {
  const res = HDWallet.fromSeed(Uint8Array.from(Buffer.from(seedHex, "hex")));
  const hd = (res as { hdWallet?: unknown }).hdWallet;
  if (!hd) throw new Error("could not derive an HD wallet from that seed");

  // selectRoles/deriveKeysAt (plural), matching the script. The singular
  // selectRole/deriveKeyAt pair returns a differently-shaped result, which is
  // part of how the two implementations drifted.
  const derived = (
    hd as {
      selectAccount(i: number): {
        selectRoles(r: number[]): { deriveKeysAt(i: number): { type: string; keys: unknown[] } };
      };
      clear(): void;
    }
  )
    .selectAccount(0)
    .selectRoles([Roles.NightExternal])
    .deriveKeysAt(0);
  if (derived.type !== "keysDerived") throw new Error("key derivation failed");

  const address = String(
    createKeystore(derived.keys[Roles.NightExternal] as Uint8Array, hrp).getBech32Address(),
  );
  (hd as { clear(): void }).clear();
  return address;
}
