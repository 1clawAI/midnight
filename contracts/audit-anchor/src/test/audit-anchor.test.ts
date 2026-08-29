// Copyright (C) 2026 1Claw
// SPDX-License-Identifier: Apache-2.0

import { describe, it, expect } from "vitest";
import { AuditAnchorSimulator } from "./AuditAnchorSimulator.js";
import { pureCircuits } from "../managed/audit-anchor/contract/index.js";
import {
  createAuditAnchorPrivateState,
  padEvents,
  MAX_EVENTS,
} from "../witnesses.js";

// TS 5.7+ parameterises Uint8Array by its backing buffer. The compiled circuits
// return the ArrayBufferLike-backed variant, so fixtures are annotated to match
// rather than every helper being widened at its call sites.
type Bytes32 = Uint8Array<ArrayBufferLike>;
const b = (fill: number): Bytes32 => new Uint8Array(32).fill(fill);

const AGENT = b(0xa1);
const OTHER_AGENT = b(0xa2);
const SK = b(0x51);
const OTHER_SK = b(0x52);
const SALT = b(0x5a);
const HEAD0 = b(0x10);

/** Freshly-registered agent: known key, known head, nothing pending. */
const state = () => createAuditAnchorPrivateState(SK, SALT, HEAD0, []);

const withEvents = (events: Bytes32[], sk: Bytes32 = SK, head: Bytes32 = HEAD0) =>
  createAuditAnchorPrivateState(sk, SALT, head, events);

/**
 * Off-chain fold, used by the anchoring CLI and the viewer to predict the
 * commitment before submitting. It deliberately calls the *compiled circuit's*
 * foldStep rather than reimplementing persistentHash encoding — the encoding is
 * the circuit's business, and a second implementation would be a second source
 * of truth.
 */
function foldOffChain(head: Bytes32, events: readonly Bytes32[]): Bytes32 {
  return events.reduce<Bytes32>((h, e) => pureCircuits.foldStep(h, e), head);
}

/** Registered agent, ready to extend. */
async function registered() {
  const sim = await AuditAnchorSimulator.create(state());
  await sim.anchorInitial(AGENT);
  return sim;
}

describe("AuditAnchor", () => {
  it("anchorInitial registers owner, commitment and epoch 1", async () => {
    const sim = await AuditAnchorSimulator.create(state());
    const l = await sim.anchorInitial(AGENT);

    expect(l.epochs.lookup(AGENT)).toBe(1n);
    expect(l.owners.lookup(AGENT)).toEqual(pureCircuits.ownerTag(SK));
    expect(l.commitments.lookup(AGENT)).toEqual(pureCircuits.headTag(HEAD0));
  });

  it("anchorInitial rejects double registration", async () => {
    const sim = await registered();
    await expect(sim.anchorInitial(AGENT)).rejects.toThrow();
  });

  it("does not publish the head itself, only a commitment to it", async () => {
    // The dual-ledger claim rests on this: the ledger must not contain the
    // audit chain head in the clear.
    const sim = await AuditAnchorSimulator.create(state());
    const l = await sim.anchorInitial(AGENT);
    expect(l.commitments.lookup(AGENT)).not.toEqual(HEAD0);
  });

  it("anchorExtend with one event matches the simulator golden vector", async () => {
    const ev = b(0xe1);
    const sim = await registered();
    const l = await sim.as(withEvents([ev])).anchorExtend(AGENT);

    expect(l.commitments.lookup(AGENT)).toEqual(
      pureCircuits.headTag(foldOffChain(HEAD0, [ev])),
    );
    expect(l.epochs.lookup(AGENT)).toBe(2n);
  });

  it("off-chain fold agrees with the circuit across a full batch", async () => {
    const events = Array.from({ length: MAX_EVENTS }, (_, i) => b(0xc0 + i));
    const sim = await registered();
    const l = await sim.as(withEvents(events)).anchorExtend(AGENT);

    expect(l.commitments.lookup(AGENT)).toEqual(
      pureCircuits.headTag(foldOffChain(HEAD0, events)),
    );
  });

  it("trailing padding slots are inert", async () => {
    // A one-event anchor with seven pad slots must produce the same commitment
    // as folding that one event — otherwise padding would silently fold in.
    const ev = b(0xe1);
    const sim = await registered();
    const l = await sim.as(withEvents([ev])).anchorExtend(AGENT);

    expect(padEvents([ev])).toHaveLength(MAX_EVENTS);
    expect(l.commitments.lookup(AGENT)).toEqual(
      pureCircuits.headTag(foldOffChain(HEAD0, [ev])),
    );
  });

  it("anchorExtend rejects a wrong prevHead", async () => {
    const sim = await registered();
    // Same key, same events — but claiming a head that was never anchored.
    await expect(
      sim.as(withEvents([b(0xe1)], SK, b(0x99))).anchorExtend(AGENT),
    ).rejects.toThrow();
  });

  it("anchorExtend rejects a wrong secretKey", async () => {
    const sim = await registered();
    await expect(
      sim.as(withEvents([b(0xe1)], OTHER_SK, HEAD0)).anchorExtend(AGENT),
    ).rejects.toThrow();
  });

  it("anchorExtend rejects squatting an unregistered agent", async () => {
    const sim = await registered();
    await expect(
      sim.as(withEvents([b(0xe1)])).anchorExtend(OTHER_AGENT),
    ).rejects.toThrow();
  });

  it("anchorExtend rejects an empty batch", async () => {
    const sim = await registered();
    await expect(sim.as(withEvents([])).anchorExtend(AGENT)).rejects.toThrow();
  });

  it("epochs increase monotonically across anchors", async () => {
    const sim = await registered();

    let head: Bytes32 = HEAD0;
    for (let round = 0; round < 3; round++) {
      const events = [b(0x70 + round)];
      await sim.as(withEvents(events, SK, head)).anchorExtend(AGENT);
      head = foldOffChain(head, events);
      expect(sim.getLedger().epochs.lookup(AGENT)).toBe(BigInt(round + 2));
    }
    expect(sim.getLedger().commitments.lookup(AGENT)).toEqual(
      pureCircuits.headTag(head),
    );
  });

  it("padEvents refuses to over-fill the fixed witness width", () => {
    const tooMany = Array.from({ length: MAX_EVENTS + 1 }, () => b(1));
    expect(() => padEvents(tooMany)).toThrow(/max is 8/);
  });
});
