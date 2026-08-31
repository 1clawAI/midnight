// Copyright (C) 2026 1Claw
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";
import {
  hasPendingSpends,
  isCaughtUp,
  isCheckpointable,
  markSpent,
  type Entry,
  type WalletState,
} from "../wallet-pool.js";

/**
 * Sync-readiness, pinned against progress values actually observed on Preprod.
 *
 * The wallet's own `isSynced` cannot be used here, and these cases are why:
 * it is true both when the wallet is genuinely caught up and when it has just
 * restored from a checkpoint and has not connected yet. The second reported a
 * wallet holding 3.9e18 DUST as `dust: 0`, and signing then failed with
 * "could not balance dust".
 */
const progress = (applied: bigint, tip: bigint, isConnected: boolean) => ({
  progress: { appliedIndex: applied, highestRelevantWalletIndex: tip, highestIndex: 0n, isConnected },
});

// The unshielded sub-wallet reports `isConnected` and nothing else — no
// appliedIndex, no tip — which is why it is held to a weaker rule.
const unshieldedProgress = (isConnected: boolean) => ({ progress: { isConnected } });

const state = (applied: bigint, tip: bigint, connected: boolean): WalletState =>
  ({
    shielded: progress(applied, tip, connected),
    unshielded: unshieldedProgress(connected),
    dust: progress(applied, tip, connected),
  }) as unknown as WalletState;

describe("isCaughtUp", () => {
  it("accepts a wallet that has reached the tip while connected", () => {
    expect(isCaughtUp(state(1_468_808n, 1_468_808n, true))).toBe(true);
  });

  // The restore race. `appliedIndex` is already in the millions from the
  // checkpoint, the tip is still 0 because the indexer has not answered, and
  // any applied >= tip test therefore passes on a wallet with no usable state.
  it("rejects a freshly restored wallet whose tip is not known yet", () => {
    expect(isCaughtUp(state(1_460_120n, 0n, false))).toBe(false);
  });

  // Same shape, but connected — a zero tip still means "nothing to be caught
  // up to", so it must not be read as success.
  it("rejects a zero tip even when connected", () => {
    expect(isCaughtUp(state(1_460_120n, 0n, true))).toBe(false);
  });

  it("rejects a wallet still catching up", () => {
    expect(isCaughtUp(state(1_463_034n, 1_468_806n, true))).toBe(false);
  });

  it("rejects a disconnected wallet even at the tip", () => {
    expect(isCaughtUp(state(1_468_808n, 1_468_808n, false))).toBe(false);
  });

  // Fees come from dust, so a caught-up shielded wallet is not sufficient.
  it("requires dust to be caught up, not just the shielded wallet", () => {
    const mixed = {
      shielded: progress(1_468_808n, 1_468_808n, true),
      unshielded: unshieldedProgress(true),
      dust: progress(1_400_000n, 1_468_808n, true),
    } as unknown as WalletState;
    expect(isCaughtUp(mixed)).toBe(false);
  });

  // The unshielded wallet publishes no indices at all. An earlier version of
  // this rule demanded progress from all three, which no live wallet could ever
  // satisfy: every balance came back "still catching up" forever.
  it("does not demand index progress from the unshielded sub-wallet", () => {
    expect(isCaughtUp(state(1_468_808n, 1_468_808n, true))).toBe(true);
  });

  it("still requires the unshielded sub-wallet to be connected", () => {
    const s = {
      shielded: progress(1_468_808n, 1_468_808n, true),
      unshielded: unshieldedProgress(false),
      dust: progress(1_468_808n, 1_468_808n, true),
    } as unknown as WalletState;
    expect(isCaughtUp(s)).toBe(false);
  });

  it("treats a state with no progress at all as not ready", () => {
    expect(isCaughtUp({} as WalletState)).toBe(false);
  });
});

/**
 * What is safe to write to disk.
 *
 * Both of these bricked a real wallet during the facade migration: the first
 * saved a scan position past coins it had not recorded, the second saved a dust
 * reservation that never clears. In each case the wallet came back reporting
 * `dust: 0` forever and could not pay a fee again.
 */
describe("isCheckpointable", () => {
  const entryFor = (latest: WalletState | null, spent = false): Entry =>
    ({ latest, spent }) as unknown as Entry;

  const readyState = (over: Record<string, unknown> = {}): WalletState =>
    ({
      shielded: progress(1_468_808n, 1_468_808n, true),
      unshielded: unshieldedProgress(true),
      dust: { ...progress(1_468_808n, 1_468_808n, true), pendingCoins: [] },
      ...over,
    }) as unknown as WalletState;

  it("accepts a caught-up wallet with nothing reserved", () => {
    expect(isCheckpointable(entryFor(readyState()))).toBe(true);
  });

  // The race the observed-state check could not win: the recipe reserves the
  // dust coin immediately, but the subscription has not emitted a state showing
  // it, so a periodic write serializes a reserved wallet that still looks clean.
  it("refuses a wallet marked spent even while its state still looks clean", () => {
    const entry = entryFor(readyState());
    expect(isCheckpointable(entry)).toBe(true);
    markSpent(entry);
    expect(isCheckpointable(entry)).toBe(false);
  });

  it("refuses a wallet whose state already shows a reservation", () => {
    const reserved = readyState({
      dust: { ...progress(1_468_808n, 1_468_808n, true), pendingCoins: [{}] },
    });
    expect(hasPendingSpends(reserved)).toBe(true);
    expect(isCheckpointable(entryFor(reserved))).toBe(false);
  });

  it("refuses a wallet that has not caught up", () => {
    const behind = readyState({
      dust: { ...progress(1_400_000n, 1_468_808n, true), pendingCoins: [] },
    });
    expect(isCheckpointable(entryFor(behind))).toBe(false);
  });

  it("refuses an entry with no state rather than treating it as clean", () => {
    expect(isCheckpointable(entryFor(null))).toBe(false);
  });

  it("treats a dust wallet with no pendingCoins field as unreserved", () => {
    expect(hasPendingSpends({ dust: {} } as unknown as WalletState)).toBe(false);
  });

  // Never cleared: the on-disk checkpoint predates the recipe and is the better
  // state to resume from anyway.
  it("keeps refusing once marked, even after the reservation would have cleared", () => {
    const entry = entryFor(readyState(), true);
    entry.latest = readyState();
    expect(isCheckpointable(entry)).toBe(false);
  });
});
