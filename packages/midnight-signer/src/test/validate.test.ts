import { describe, it, expect } from "vitest";
import {
  requireSeed,
  requireNetwork,
  requireAddress,
  requireAmountBaseUnits,
  requireBoolean,
  ValidationError,
} from "../validate.js";

const SEED = "a".repeat(64);
const ADDR =
  "mn_shield-addr_test1tdc03xvkcr26w2zt4pghkn4h2y4f8lcld8ujncy9tuszmu52nemsxqxpxfs7q";

describe("requireSeed", () => {
  it("accepts 64 hex and normalises case", () => {
    expect(requireSeed("AB".repeat(32))).toBe("ab".repeat(32));
  });
  it("rejects wrong length or non-hex", () => {
    for (const bad of ["", "abc", "z".repeat(64), "a".repeat(63), "a".repeat(65)]) {
      expect(() => requireSeed(bad)).toThrow(ValidationError);
    }
  });
  it("never echoes the seed in the error", () => {
    try {
      requireSeed("deadbeef");
    } catch (e) {
      expect((e as Error).message).not.toContain("deadbeef");
    }
  });
});

describe("requireNetwork", () => {
  it("accepts the preprod aliases", () => {
    for (const n of ["midnight", "midnight-preprod", "MIDNIGHT_PREPROD", "preprod"]) {
      expect(requireNetwork(n)).toBe("preprod");
    }
  });
  it("refuses mainnet with a specific message", () => {
    // Wave 1 must not be able to sign on mainnet by any route.
    expect(() => requireNetwork("midnight-mainnet")).toThrow(/mainnet is not supported/);
  });
  it("refuses unknown networks", () => {
    expect(() => requireNetwork("cardano")).toThrow(/unsupported network/);
    expect(() => requireNetwork(undefined)).toThrow(/missing/);
  });
});

describe("requireAddress", () => {
  it("accepts a real Preprod address", () => {
    expect(requireAddress(ADDR)).toBe(ADDR);
  });
  it("rejects other chains' addresses", () => {
    expect(() => requireAddress("0x" + "0".repeat(40))).toThrow(/not a Midnight address/);
    expect(() => requireAddress("addr_test1vabcdefghijk")).toThrow(/not a Midnight address/);
  });
  it("rejects truncated and malformed input", () => {
    expect(() => requireAddress("mn_addr")).toThrow(/too short/);
    expect(() => requireAddress("mn_addr1!!!!!!!!!!!!!!!!")).toThrow(/bech32m/);
    expect(() => requireAddress("")).toThrow(/required/);
  });
});

describe("requireAmountBaseUnits", () => {
  it("parses integer strings without precision loss", () => {
    expect(requireAmountBaseUnits("123456789012345678901234567890")).toBe(
      123456789012345678901234567890n,
    );
  });
  it("rejects zero, negatives, floats and junk", () => {
    for (const bad of ["0", "-1", "1.5", "1e6", "", "abc", null]) {
      expect(() => requireAmountBaseUnits(bad)).toThrow(ValidationError);
    }
  });
});

describe("requireBoolean", () => {
  it("defaults when absent and rejects non-booleans", () => {
    expect(requireBoolean(undefined, "broadcast", true)).toBe(true);
    expect(requireBoolean(false, "broadcast", true)).toBe(false);
    expect(() => requireBoolean("yes", "broadcast", true)).toThrow(/must be a boolean/);
  });
});
