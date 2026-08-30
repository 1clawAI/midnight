import { describe, expect, it } from "vitest";
import { SyncLiveness, fingerprint, isConnected, type ObservedState } from "./sync-liveness.js";

const OPTS = { stallMs: 300_000, disconnectMs: 90_000, silenceMs: 270_000 };

/** A state with real SyncProgress fields. */
const at = (applied: bigint, highest?: bigint, connected = true): ObservedState => ({
  unshielded: { progress: { appliedIndex: applied, highestIndex: highest, isConnected: connected } },
  dust: { progress: { appliedIndex: applied, isConnected: connected } },
  shielded: { progress: { appliedIndex: applied, isConnected: connected } },
});

describe("fingerprint", () => {
  it("changes when any sub-wallet advances", () => {
    expect(fingerprint(at(1n))).not.toBe(fingerprint(at(2n)));
  });

  it("only the shielded wallet advancing still counts as movement", () => {
    const a: ObservedState = { unshielded: { progress: { appliedIndex: 5n } }, shielded: { progress: { appliedIndex: 1n } } };
    const b: ObservedState = { unshielded: { progress: { appliedIndex: 5n } }, shielded: { progress: { appliedIndex: 2n } } };
    expect(fingerprint(a)).not.toBe(fingerprint(b));
  });

  it("is constant for the fields the first version guessed at", () => {
    // `synced`/`total` are not SyncProgress fields. Reading them yields
    // undefined for every sample, which is exactly how a healthy sync came to
    // look wedged. This pins the reason the progressIsLive rule exists.
    const wrong = (n: bigint) => ({ unshielded: { progress: { synced: n, total: 100n } } }) as unknown as ObservedState;
    expect(fingerprint(wrong(1n))).toBe(fingerprint(wrong(99n)));
  });
});

describe("isConnected", () => {
  it("is false when any sub-wallet reports a lost connection", () => {
    expect(isConnected(at(1n, 10n, false))).toBe(false);
    expect(isConnected(at(1n, 10n, true))).toBe(true);
  });

  it("treats an absent flag as connected, not as a drop", () => {
    expect(isConnected({ unshielded: { progress: { appliedIndex: 1n } } })).toBe(true);
  });
});

describe("SyncLiveness", () => {
  it("never reports a progress stall while the fingerprint has never moved", () => {
    // Preprod leaves highestIndex empty and appliedIndex flat; this is the
    // shape that would have failed every run had the timeout armed itself.
    const l = new SyncLiveness(OPTS, 0);
    for (let t = 0; t <= 3_600_000; t += 20_000) l.observe(at(0n), t);
    expect(l.progressIsLive).toBe(false);
    expect(l.verdict(3_600_000)).toEqual({ kind: "healthy" });
  });

  it("arms only after a second, differing sample", () => {
    const l = new SyncLiveness(OPTS, 0);
    l.observe(at(1n), 0);
    expect(l.progressIsLive).toBe(false); // baseline, not movement
    l.observe(at(2n), 1_000);
    expect(l.progressIsLive).toBe(true);
  });

  it("reports a stall once progress is trusted and then freezes", () => {
    const l = new SyncLiveness(OPTS, 0);
    l.observe(at(1n), 0);
    l.observe(at(2n), 1_000); // now armed
    // Keep emitting — a frozen sync still produces state; it just stops
    // advancing. Without these samples this would be the silence case instead,
    // which is what the first version of this test actually asserted.
    for (let t = 2_000; t <= 400_000; t += 20_000) l.observe(at(2n), t);
    expect(l.verdict(250_000)).toEqual({ kind: "healthy" }); // inside the window
    expect(l.verdict(400_000).kind).toBe("stalled");
    expect(l.verdict(400_000)).toMatchObject({ reason: expect.stringContaining("no sync progress") });
  });

  it("stays healthy while progress keeps advancing", () => {
    const l = new SyncLiveness(OPTS, 0);
    let applied = 0n;
    for (let t = 0; t <= 3_600_000; t += 60_000) l.observe(at(++applied), t);
    expect(l.progressIsLive).toBe(true);
    expect(l.verdict(3_600_000)).toEqual({ kind: "healthy" });
  });

  it("reports a disconnect that outlasts the window", () => {
    const l = new SyncLiveness(OPTS, 0);
    l.observe(at(1n, 10n, false), 1_000);
    expect(l.verdict(60_000)).toEqual({ kind: "healthy" }); // still inside
    expect(l.verdict(120_000)).toMatchObject({ kind: "stalled", reason: expect.stringContaining("disconnected") });
  });

  it("forgives a disconnect that recovers inside the window", () => {
    const l = new SyncLiveness(OPTS, 0);
    l.observe(at(1n, 10n, false), 10_000);
    l.observe(at(1n, 10n, true), 40_000); // reconnected
    expect(l.connected).toBe(true);
    expect(l.verdict(120_000)).toEqual({ kind: "healthy" });
  });

  it("names silence as itself when the stream stops emitting", () => {
    // The original failure: seventy minutes of nothing. Reporting that as a
    // disconnect would point the next investigation at the wrong thing.
    const l = new SyncLiveness(OPTS, 0);
    l.observe(at(1n), 0);
    l.observe(at(2n), 1_000);
    expect(l.verdict(200_000)).toEqual({ kind: "healthy" });
    expect(l.verdict(400_000)).toMatchObject({ reason: expect.stringContaining("no state emissions") });
  });

  it("prefers the disconnect reason when both conditions hold", () => {
    const l = new SyncLiveness(OPTS, 0);
    l.observe(at(1n), 0);
    l.observe(at(2n), 1_000); // armed
    // Keep emitting so this is the disconnect case, not the silence case.
    for (let t = 2_000; t <= 400_000; t += 20_000) l.observe(at(2n, undefined, false), t);
    expect(l.verdict(400_000)).toMatchObject({ reason: expect.stringContaining("disconnected") });
  });
});
