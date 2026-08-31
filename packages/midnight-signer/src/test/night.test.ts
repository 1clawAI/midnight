// Copyright (C) 2026 1Claw
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { unshieldedToken } from "@midnight-ntwrk/midnight-js-protocol/ledger";
import { addressOf, hasSpendableCoins, publicKeyOf, splitBalances } from "../night.js";
import type { WalletState } from "../wallet-pool.js";

const NIGHT = unshieldedToken().raw;

// The facade state is a large class instance; these accessors only ever touch
// the four paths below, so a structural stand-in exercises them honestly.
const state = (shape: unknown): WalletState => shape as WalletState;

describe("splitBalances", () => {
  it("reads NIGHT from the unshielded sub-wallet", () => {
    const { night } = splitBalances(state({ unshielded: { balances: { [NIGHT]: 5_000_000n } } }));
    expect(night).toBe("5000000");
  });

  it("reports DUST from the dust sub-wallet, evaluated at a point in time", () => {
    const { dust } = splitBalances(state({ dust: { balance: () => 2159n } }));
    expect(dust).toBe("2159");
  });

  // The regression this migration exists to fix. The Zswap-only wallet had no
  // DustWallet, so DUST was inferred as "the non-native token, else 0" and a
  // wallet that could not pay a single fee reported a confident "0".
  it("distinguishes 'no DUST' from 'cannot see DUST'", () => {
    expect(splitBalances(state({ dust: { balance: () => 0n } })).dust).toBe("0");
    expect(splitBalances(state({})).dust).toBeNull();
  });

  it("defaults NIGHT to 0 rather than throwing when the wallet holds none", () => {
    expect(splitBalances(state({ unshielded: { balances: {} } })).night).toBe("0");
    expect(splitBalances(state({})).night).toBe("0");
  });

  it("passes through every token in raw, not just NIGHT", () => {
    const { raw } = splitBalances(
      state({ unshielded: { balances: { [NIGHT]: 1n, "02beef": 7n } } }),
    );
    expect(raw).toEqual({ [NIGHT]: "1", "02beef": "7" });
  });
});

describe("addressOf / publicKeyOf", () => {
  // `coinPublicKeyString` is a method on ShieldedAddress, not a property.
  // Reading it as a property yielded a function object, not a key.
  it("calls coinPublicKeyString rather than reading it", () => {
    const s = state({ shielded: { address: { coinPublicKeyString: () => "0xdead" } } });
    expect(publicKeyOf(s)).toBe("0xdead");
  });

  it("throws rather than returning a placeholder when absent", () => {
    expect(() => addressOf(state({}))).toThrow(/shielded address/);
    expect(() => publicKeyOf(state({}))).toThrow(/coin public key/);
    expect(() => publicKeyOf(state({ shielded: { address: {} } }))).toThrow(/coin public key/);
  });

  // addressOf's bech32m encoding needs a real ShieldedAddress and is covered by
  // the live check against Preprod, not here: a stub would only assert that a
  // fake was passed through.
});

describe("hasSpendableCoins", () => {
  it("tracks the unshielded UTXO set, which is what a transfer spends", () => {
    expect(hasSpendableCoins(state({ unshielded: { availableCoins: [{}] } }))).toBe(true);
    expect(hasSpendableCoins(state({ unshielded: { availableCoins: [] } }))).toBe(false);
    expect(hasSpendableCoins(state({}))).toBe(false);
  });

  it("ignores shielded coins, which this signer never spends", () => {
    expect(hasSpendableCoins(state({ shielded: { availableCoins: [{}, {}] } }))).toBe(false);
  });
});
