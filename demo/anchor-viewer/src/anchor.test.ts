import { describe, it, expect } from "vitest";
import {
  fromHex,
  toHex,
  bytes32,
  foldEvents,
  expectedCommitment,
  verifyAgainstChain,
  readLedger,
} from "./anchor.js";

const b = (fill: number) => new Uint8Array(32).fill(fill);

describe("hex helpers", () => {
  it("round-trips and tolerates 0x", () => {
    expect(toHex(fromHex("0xdeadbeef"))).toBe("deadbeef");
  });
  it("rejects malformed hex", () => {
    expect(() => fromHex("xyz")).toThrow(/valid hex/);
    expect(() => fromHex("abc")).toThrow(/valid hex/);
  });
  it("right-pads to 32 bytes and refuses oversize", () => {
    expect(bytes32("ff")).toHaveLength(32);
    expect(bytes32("ff")[0]).toBe(255);
    expect(() => bytes32("ff".repeat(33))).toThrow(/longer than 32/);
  });
});

describe("fold verification", () => {
  it("an empty batch leaves the head untouched", () => {
    const h = b(1);
    expect(toHex(foldEvents(h, []))).toBe(toHex(h));
  });

  it("order matters — the fold is a chain, not a set", () => {
    const h = b(1);
    const a = foldEvents(h, [b(2), b(3)]);
    const c = foldEvents(h, [b(3), b(2)]);
    expect(toHex(a)).not.toBe(toHex(c));
  });

  it("verifies a correct claim and rejects a tampered one", () => {
    const head = b(0x10);
    const events = [b(0xe1), b(0xe2)];
    const onChain = toHex(expectedCommitment(head, events));

    expect(verifyAgainstChain(onChain, head, events).ok).toBe(true);
    // One altered event must not reproduce the commitment — this is the whole
    // point of anchoring the log.
    expect(verifyAgainstChain(onChain, head, [b(0xe1), b(0xff)]).ok).toBe(false);
    // Nor may a dropped event.
    expect(verifyAgainstChain(onChain, head, [b(0xe1)]).ok).toBe(false);
    // Nor a different starting head.
    expect(verifyAgainstChain(onChain, b(0x11), events).ok).toBe(false);
  });
});

describe("readLedger", () => {
  it("joins the three maps and sorts deterministically", () => {
    const k1 = b(0xa2);
    const k2 = b(0xa1);
    const rows = readLedger({
      commitments: [
        [k1, b(0xc1)],
        [k2, b(0xc2)],
      ],
      epochs: { member: () => true, lookup: () => 3n },
      owners: { member: () => true, lookup: () => b(0x0e) },
    });
    expect(rows).toHaveLength(2);
    expect(rows[0].agentCommitment < rows[1].agentCommitment).toBe(true);
    expect(rows[0].epoch).toBe(3n);
  });

  it("tolerates an agent present in commitments but not owners", () => {
    const rows = readLedger({
      commitments: [[b(1), b(2)]],
      epochs: { member: () => false, lookup: () => 0n },
      owners: { member: () => false, lookup: () => b(0) },
    });
    expect(rows[0].owner).toBeNull();
    expect(rows[0].epoch).toBe(0n);
  });
});
