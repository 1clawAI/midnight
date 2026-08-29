// Copyright (C) 2026 1Claw
// SPDX-License-Identifier: Apache-2.0

/**
 * Decoding and verification, kept separate from the DOM so it can be tested.
 *
 * The important property: this module never reimplements the contract's hashing.
 * `agentCommitment`, the chain fold and the head/owner tags all come from the
 * compiled contract's own `pureCircuits`, so the viewer cannot disagree with the
 * circuit about what a commitment should be — which is the only thing that
 * makes "verify offline" meaningful rather than decorative.
 */

import { pureCircuits } from "../../../contracts/audit-anchor/src/managed/audit-anchor/contract/index.js";

export type AnchorRow = {
  agentCommitment: string;
  commitment: string;
  epoch: bigint;
  owner: string | null;
};

export const toHex = (b: Uint8Array): string =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

export function fromHex(hex: string): Uint8Array {
  const clean = hex.trim().replace(/^0x/i, "");
  if (!/^[0-9a-f]*$/i.test(clean) || clean.length % 2 !== 0) {
    throw new Error("not valid hex");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** 32-byte value, right-padded — matches how fixtures and event hashes arrive. */
export function bytes32(hex: string): Uint8Array {
  const b = fromHex(hex);
  if (b.length > 32) throw new Error("value longer than 32 bytes");
  const out = new Uint8Array(32);
  out.set(b);
  return out;
}

/**
 * Fold a batch of event hashes onto a head, using the contract's own step.
 * Mirrors anchorExtend exactly, because it *is* the same circuit code.
 */
export function foldEvents(head: Uint8Array, events: readonly Uint8Array[]): Uint8Array {
  return events.reduce<Uint8Array>((h, e) => pureCircuits.foldStep(h, e), head);
}

/** What the ledger should hold after folding these events onto this head. */
export function expectedCommitment(
  head: Uint8Array,
  events: readonly Uint8Array[],
): Uint8Array {
  return pureCircuits.headTag(foldEvents(head, events));
}

/** Verify a claimed head+events against the on-chain commitment. */
export function verifyAgainstChain(
  onChainCommitment: string,
  head: Uint8Array,
  events: readonly Uint8Array[],
): { ok: boolean; expected: string } {
  const expected = toHex(expectedCommitment(head, events));
  return { ok: expected === onChainCommitment.toLowerCase(), expected };
}

/** Read the three ledger maps into rows keyed by agent commitment. */
export function readLedger(ledger: {
  commitments: Iterable<[Uint8Array, Uint8Array]>;
  epochs: { lookup(k: Uint8Array): bigint; member(k: Uint8Array): boolean };
  owners: { lookup(k: Uint8Array): Uint8Array; member(k: Uint8Array): boolean };
}): AnchorRow[] {
  const rows: AnchorRow[] = [];
  for (const [key, commitment] of ledger.commitments) {
    rows.push({
      agentCommitment: toHex(key),
      commitment: toHex(commitment),
      epoch: ledger.epochs.member(key) ? ledger.epochs.lookup(key) : 0n,
      owner: ledger.owners.member(key) ? toHex(ledger.owners.lookup(key)) : null,
    });
  }
  return rows.sort((a, b) => a.agentCommitment.localeCompare(b.agentCommitment));
}
