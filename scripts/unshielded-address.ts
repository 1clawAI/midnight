// Copyright (C) 2026 1Claw
// SPDX-License-Identifier: Apache-2.0

/**
 * Derive the *unshielded* NIGHT address for a seed.
 *
 * This used to hand-roll the encoding: derive the key under Roles.NightExternal
 * and bech32m-encode those bytes directly with UnshieldedAddress.codec. The
 * derivation was right — the key bytes match the SDK exactly — but the encoding
 * was not, and it produced a different, wrong address. We faucet-funded that
 * address, then spent a long time concluding the toolchain and Lace disagreed,
 * when in fact only this file did.
 *
 * It now goes through `createKeystore().getBech32Address()`, the same path the
 * wallet SDK and Lace use. Note the scope: `@midnightntwrk/wallet-sdk` has no
 * hyphen and is a different package from `@midnight-ntwrk/wallet`.
 */
import { Buffer } from "node:buffer";
import { HDWallet, Roles, createKeystore } from "@midnightntwrk/wallet-sdk";
import { setNetworkId, getNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

/** Preprod. Set once here so callers cannot derive against the wrong network. */
setNetworkId("preprod");

export const PREPROD_HRP = "preprod";

export function unshieldedAddressForSeed(seedHex: string): string {
  const res = HDWallet.fromSeed(Buffer.from(seedHex, "hex")) as {
    type: string;
    hdWallet?: {
      selectAccount(i: number): {
        selectRoles(r: number[]): { deriveKeysAt(i: number): { type: string; keys: unknown[] } };
      };
      clear(): void;
    };
  };
  if (res.type !== "seedOk" || !res.hdWallet) {
    throw new Error("could not derive an HD wallet from that seed");
  }

  const derived = res.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.NightExternal])
    .deriveKeysAt(0);
  if (derived.type !== "keysDerived") throw new Error("key derivation failed");

  const address = String(
    createKeystore(derived.keys[Roles.NightExternal], getNetworkId()).getBech32Address(),
  );
  res.hdWallet.clear();
  return address;
}
