// Copyright (C) 2026 1Claw
// SPDX-License-Identifier: Apache-2.0

/**
 * Pure request validation.
 *
 * Kept free of any SDK or network dependency so it can be tested exhaustively
 * without a synced wallet — which matters, because a wallet takes ~2h to sync
 * and these checks are the ones standing between a malformed request and a
 * signed transaction.
 */

export class ValidationError extends Error {}

const SEED_RE = /^[0-9a-f]{64}$/i;

/** Networks this sidecar will serve. Wave 1 is Preprod-only, by design. */
const PREPROD_ALIASES = new Set(["midnight", "midnight-preprod", "midnight_preprod", "preprod"]);
const MAINNET_ALIASES = new Set(["midnight-mainnet", "midnight_mainnet", "mainnet"]);

export function requireSeed(raw: unknown): string {
  if (typeof raw !== "string" || !SEED_RE.test(raw.trim())) {
    // Deliberately does not echo the value.
    throw new ValidationError("seed_hex must be 64 hex characters");
  }
  return raw.trim().toLowerCase();
}

export function requireNetwork(raw: unknown): "preprod" {
  const n = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (MAINNET_ALIASES.has(n)) {
    throw new ValidationError("Midnight mainnet is not supported; this sidecar is Preprod-only");
  }
  if (!PREPROD_ALIASES.has(n)) {
    throw new ValidationError(`unsupported network: ${n || "(missing)"}. Expected midnight-preprod`);
  }
  return "preprod";
}

/**
 * Bech32m-ish shape check on a Midnight address.
 *
 * The wallet SDK does the authoritative decode; this exists to reject obvious
 * mistakes (an EVM address, a Cardano address, a truncated paste) before we
 * spend a sync or a proof on them.
 */
export function requireAddress(raw: unknown): string {
  const a = typeof raw === "string" ? raw.trim() : "";
  if (!a) throw new ValidationError("to_address is required");
  const looksMidnight =
    a.startsWith("mn_shield-addr") || a.startsWith("mn_addr") || a.startsWith("addr_mn");
  if (!looksMidnight) {
    throw new ValidationError(`not a Midnight address: ${a.slice(0, 24)}…`);
  }
  if (a.length < 20) throw new ValidationError("to_address is too short to be valid");
  if (!/^[a-z0-9_\-]+$/i.test(a)) {
    throw new ValidationError("to_address contains characters not valid in bech32m");
  }
  return a;
}

/**
 * Amounts arrive as a decimal string of base units so no precision is lost in
 * JSON. Rejecting anything non-integral here means the caller cannot smuggle a
 * float and have it silently truncate to a different amount than intended.
 */
export function requireAmountBaseUnits(raw: unknown): bigint {
  const s = typeof raw === "string" ? raw.trim() : typeof raw === "number" ? String(raw) : "";
  if (!/^\d+$/.test(s)) {
    throw new ValidationError("amount_base_units must be a non-negative integer string");
  }
  const v = BigInt(s);
  if (v <= 0n) throw new ValidationError("amount_base_units must be greater than zero");
  return v;
}

export function requireBoolean(raw: unknown, field: string, fallback: boolean): boolean {
  if (raw === undefined || raw === null) return fallback;
  if (typeof raw !== "boolean") throw new ValidationError(`${field} must be a boolean`);
  return raw;
}
