// Copyright (C) 2026 1Claw
// SPDX-License-Identifier: Apache-2.0

import type { WitnessContext } from "@midnight-ntwrk/compact-runtime";
import type { Ledger } from "./managed/audit-anchor/contract/index.js";

/** Fixed witness width of `localNewEventHashes` — must match `maxEvents()`. */
export const MAX_EVENTS = 8;

const ZERO32 = new Uint8Array(32);

/**
 * Private state for the audit anchor.
 *
 * None of this reaches the ledger. `secretKey` and `registrationSalt` live in
 * the 1Claw vault at `agents/{id}/midnight/anchor-secret`; `lastHead` and
 * `pendingEvents` are local bookkeeping between anchors.
 */
export type AuditAnchorPrivateState = {
  readonly secretKey: Uint8Array;
  readonly registrationSalt: Uint8Array;
  /** Chain head as of the last *confirmed* anchor. */
  readonly lastHead: Uint8Array;
  /** `integrity_hash` of each audit event since `lastHead`, oldest first. */
  readonly pendingEvents: readonly Uint8Array[];
};

export const createAuditAnchorPrivateState = (
  secretKey: Uint8Array,
  registrationSalt: Uint8Array,
  lastHead: Uint8Array = ZERO32,
  pendingEvents: readonly Uint8Array[] = [],
): AuditAnchorPrivateState => ({
  secretKey,
  registrationSalt,
  lastHead,
  pendingEvents,
});

/**
 * Pad the pending events out to the circuit's fixed width.
 *
 * The circuit ignores slots at or past `localEventCount`, so the padding value
 * is not security-relevant — but it must be *present*, because a `Vector<8, _>`
 * witness has to supply exactly eight elements.
 */
export function padEvents(events: readonly Uint8Array[]): Uint8Array[] {
  if (events.length > MAX_EVENTS) {
    throw new Error(
      `cannot anchor ${events.length} events in one call; max is ${MAX_EVENTS}`,
    );
  }
  const out = events.slice();
  while (out.length < MAX_EVENTS) out.push(ZERO32);
  return out;
}

export const witnesses = {
  localSecretKey: ({
    privateState,
  }: WitnessContext<Ledger, AuditAnchorPrivateState>): [
    AuditAnchorPrivateState,
    Uint8Array,
  ] => [privateState, privateState.secretKey],

  localPrevHead: ({
    privateState,
  }: WitnessContext<Ledger, AuditAnchorPrivateState>): [
    AuditAnchorPrivateState,
    Uint8Array,
  ] => [privateState, privateState.lastHead],

  localEventCount: ({
    privateState,
  }: WitnessContext<Ledger, AuditAnchorPrivateState>): [
    AuditAnchorPrivateState,
    bigint,
  ] => [privateState, BigInt(privateState.pendingEvents.length)],

  localNewEventHashes: ({
    privateState,
  }: WitnessContext<Ledger, AuditAnchorPrivateState>): [
    AuditAnchorPrivateState,
    Uint8Array[],
  ] => [privateState, padEvents(privateState.pendingEvents)],
};
