// Copyright (C) 2026 1Claw
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { unshieldedAddressFor, PREPROD_HRP } from "../derive-unshielded.js";

/**
 * Derivation vectors.
 *
 * This is the most important test in the suite. Everything else checks that we
 * reject bad input; this checks that we derive the *right wallet*. A dependency
 * bump that silently changes the HD path, the role index, or the bech32m
 * encoding would otherwise pass every other test while sending funds to an
 * address nobody holds the key for — and on-chain, that is unrecoverable.
 *
 * The seeds are deliberately synthetic. Pinning a vector requires committing
 * the seed next to the address it produces, so no seed here may ever hold
 * value; these are patterns no wallet would generate.
 */
const VECTORS: ReadonlyArray<readonly [string, string, string]> = [
  [
    "all zeroes",
    "0000000000000000000000000000000000000000000000000000000000000000",
    "mn_addr_preprod1ka4a3kfwkasf36fcq5d0n44l9jqa3068atf254zzefsvqs6xx79stxdtwc",
  ],
  [
    "all ones",
    "1111111111111111111111111111111111111111111111111111111111111111",
    "mn_addr_preprod1v636fl960wkjuytj900tuk0vaktn4dvdky5g8dpv8nsw9j2ke4ysfpsfnj",
  ],
  [
    "counting bytes 0x00..0x1f",
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
    "mn_addr_preprod1dj9edn49plgznx9ys7uga0cgwgetty538nvj00pec8r0hw075gasv6epye",
  ],
  [
    "all high bytes",
    "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    "mn_addr_preprod1kwdaxksl92cjgd8739gzy3wy6j0f2hnzx9f0lvgg604tw4m43zcqdnvxwr",
  ],
];

describe("unshielded address derivation", () => {
  it.each(VECTORS)("%s derives a stable address", (_label, seed, expected) => {
    expect(unshieldedAddressFor(seed)).toBe(expected);
  });

  it("is case-insensitive in the seed", () => {
    const lower = VECTORS[2][1];
    expect(unshieldedAddressFor(lower.toUpperCase())).toBe(unshieldedAddressFor(lower));
  });

  it("distinct seeds derive distinct addresses", () => {
    const addresses = new Set(VECTORS.map(([, seed]) => unshieldedAddressFor(seed)));
    expect(addresses.size).toBe(VECTORS.length);
  });

  it("uses the preprod HRP, not testnet", () => {
    // The two are encoded independently even though Preprod runs under the
    // TestNet network id, and the faucet matches on the HRP — so getting this
    // wrong produces an address the faucet silently refuses.
    expect(PREPROD_HRP).toBe("preprod");
    for (const [, seed] of VECTORS) {
      expect(unshieldedAddressFor(seed).startsWith("mn_addr_preprod1")).toBe(true);
    }
  });

  it("produces addresses of a consistent length", () => {
    const lengths = new Set(VECTORS.map(([, seed]) => unshieldedAddressFor(seed).length));
    expect(lengths.size).toBe(1);
  });
});
