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
 *
 * These vectors were regenerated on 2026-08-31. The originals were produced by
 * an implementation that bech32m-encoded the derived key bytes directly instead
 * of going through createKeystore(), so they pinned an address the SDK never
 * derives — the test did exactly what its own warning describes, and locked in
 * the wrong wallet.
 *
 * They are not simply whatever the new code emits. Each was cross-checked
 * against scripts/unshielded-address.ts, a separate implementation of the same
 * derivation, and all four agree. A vector regenerated from the code it
 * verifies is not a test.
 */
const VECTORS: ReadonlyArray<readonly [string, string, string]> = [
  [
    "all zeroes",
    "0000000000000000000000000000000000000000000000000000000000000000",
    "mn_addr_preprod13h0e3c2m7rcfem6wvjljnyjmxy5rkg9kkwcldzt73ya5pv7c4p8svej7lr",
  ],
  [
    "all ones",
    "1111111111111111111111111111111111111111111111111111111111111111",
    "mn_addr_preprod164t3m7skgcgnjv7r7xmduxhnznvdvz4wu0pw08ks865cg6eu6nss58n6rs",
  ],
  [
    "counting bytes 0x00..0x1f",
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
    "mn_addr_preprod1ggynfcxm0v4hy9ug3gmm8jhxe0q03fh3ke9fszx6uyjyasa553dsa4le9g",
  ],
  [
    "all high bytes",
    "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
    "mn_addr_preprod1fge6yp3uhlr728uzunslymlm96fd839gtua052axwnnytp0g324q0gt2kk",
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
