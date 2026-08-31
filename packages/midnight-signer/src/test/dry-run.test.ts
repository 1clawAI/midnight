// Copyright (C) 2026 1Claw
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import { collectDryRunProblems, type DryRunFacts } from "../routes.js";

/**
 * Dry-run failure paths.
 *
 * These are the states a real wallet spends most of its life in — freshly
 * faucet-funded with NIGHT but no DUST yet, or still catching up after a
 * restart. None of them can be produced on demand against
 * live Preprod, which is exactly why the decision was pulled out of the network
 * call: given the facts, the verdict is pure and can be pinned.
 */
const ADDR = "mn_addr_preprod1ka4a3kfwkasf36fcq5d0n44l9jqa3068atf254zzefsvqs6xx79stxdtwc";

/** A wallet that can actually transact; each test spoils one thing. */
function healthy(over: Partial<DryRunFacts> = {}): DryRunFacts {
  return {
    nightBaseUnits: "5000000000", // 5,000 NIGHT, one faucet grant
    dustBaseUnits: "1000000",
    hasCoins: true,
    amountBaseUnits: 1_000_000n,
    unshieldedAddress: ADDR,
    synced: true,
    ...over,
  };
}

describe("collectDryRunProblems", () => {
  it("passes a wallet that can transact", () => {
    expect(collectDryRunProblems(healthy())).toEqual([]);
  });

  it("flags no DUST — the failure people actually hit", () => {
    // NIGHT arrives from the faucet instantly; DUST accrues from holding it.
    // A wallet in this state looks funded and cannot pay a fee.
    const problems = collectDryRunProblems(healthy({ dustBaseUnits: "0" }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("no DUST");
  });

  it("flags zero UTXOs distinctly from an unfunded wallet", () => {
    const problems = collectDryRunProblems(healthy({ hasCoins: false }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("no spendable unshielded UTXOs");
  });

  it("flags an unsynced wallet first, since it makes the rest stale", () => {
    const problems = collectDryRunProblems(healthy({ synced: false }));
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("still catching up");
  });

  // The regression that motivated the sync gate: restoring from a checkpoint
  // emits a stale tip where DUST reads 0 and UTXOs look absent, so an unsynced
  // wallet would otherwise be reported as broke rather than as not-yet-ready.
  it("does not claim a wallet is unfunded merely because it is unsynced", () => {
    const problems = collectDryRunProblems(
      healthy({ synced: false, dustBaseUnits: "0", hasCoins: false, nightBaseUnits: "0" }),
    );
    expect(problems[0]).toContain("still catching up");
  });

  it("flags an unfunded address and names the address to fund", () => {
    const problems = collectDryRunProblems(healthy({ nightBaseUnits: "0" }));
    expect(problems.some((p) => p.includes("no unshielded NIGHT"))).toBe(true);
    // Without the address in the message the operator has to go find it.
    expect(problems.some((p) => p.includes(ADDR))).toBe(true);
  });

  it("distinguishes 'unfunded' from 'not enough', and never reports both", () => {
    const empty = collectDryRunProblems(healthy({ nightBaseUnits: "0" }));
    const short = collectDryRunProblems(healthy({ nightBaseUnits: "5", amountBaseUnits: 10n }));
    expect(empty.some((p) => p.includes("no unshielded NIGHT"))).toBe(true);
    expect(empty.some((p) => p.includes("insufficient NIGHT"))).toBe(false);
    expect(short.some((p) => p.includes("insufficient NIGHT"))).toBe(true);
    expect(short.some((p) => p.includes("no unshielded NIGHT"))).toBe(false);
  });

  it("reports the shortfall with both numbers", () => {
    const [problem] = collectDryRunProblems(
      healthy({ nightBaseUnits: "5", amountBaseUnits: 10n }),
    );
    expect(problem).toContain("have 5");
    expect(problem).toContain("need 10");
  });

  it("allows spending the exact balance", () => {
    expect(collectDryRunProblems(healthy({ nightBaseUnits: "100", amountBaseUnits: 100n }))).toEqual([]);
  });

  it("collects every problem at once rather than stopping at the first", () => {
    // A brand-new wallet: no NIGHT, no coins, no DUST. Reporting one at a time
    // would mean three round trips to learn what funding it needs.
    const problems = collectDryRunProblems(
      healthy({ nightBaseUnits: "0", dustBaseUnits: "0", hasCoins: false }),
    );
    expect(problems).toHaveLength(3);
  });

  it("treats an empty balance string as zero rather than throwing", () => {
    // The indexer returns "" for an address it has never seen; BigInt("") throws.
    expect(() => collectDryRunProblems(healthy({ dustBaseUnits: "", nightBaseUnits: "" }))).not.toThrow();
  });
});
