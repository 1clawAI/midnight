// Copyright (C) 2026 1Claw
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { WalletBuilder } from "@midnight-ntwrk/wallet";
import { NetworkId } from "@midnight-ntwrk/zswap";
import { CFG } from "./config.js";

/**
 * Keeps built wallets warm, keyed by seed.
 *
 * Building a wallet opens indexer connections and takes seconds, so building one
 * per request would make signing unusable. Against that, this process holds raw
 * seeds in memory, so entries expire rather than living for the process
 * lifetime. Keys are a hash of the seed — the seed itself is never used as a map
 * key, logged, or included in an error.
 */

export type WalletState = Record<string, unknown>;

type Entry = {
  wallet: Awaited<ReturnType<typeof WalletBuilder.build>>;
  latest: WalletState | null;
  lastUsed: number;
  unsubscribe: () => void;
};

const pool = new Map<string, Entry>();

const keyFor = (seedHex: string): string =>
  createHash("sha256").update(seedHex).digest("hex").slice(0, 32);

export async function acquire(seedHex: string): Promise<Entry> {
  const key = keyFor(seedHex);
  const existing = pool.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing;
  }

  const wallet = await WalletBuilder.build(
    CFG.indexer,
    CFG.indexerWs,
    CFG.proofServer,
    CFG.node,
    seedHex,
    NetworkId.TestNet, // Preprod runs under the TestNet id
    "warn",
  );
  wallet.start();

  const entry: Entry = { wallet, latest: null, lastUsed: Date.now(), unsubscribe: () => {} };
  const sub = wallet.state().subscribe((s: unknown) => {
    entry.latest = s as WalletState;
  });
  entry.unsubscribe = () => sub.unsubscribe();

  pool.set(key, entry);
  return entry;
}

/**
 * Wait for the wallet to emit at least one state.
 *
 * Bounded deliberately: an unfunded or unreachable wallet would otherwise leave
 * the request hanging until the client's own timeout, which reads as a hung
 * sidecar rather than a wallet that has nothing to report.
 */
export async function firstState(entry: Entry, timeoutMs = 20_000): Promise<WalletState> {
  const deadline = Date.now() + timeoutMs;
  while (!entry.latest) {
    if (Date.now() > deadline) {
      throw new Error(
        "wallet produced no state within timeout — check the indexer URL and that the proof server is running",
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return entry.latest;
}

/** Drop wallets idle past the TTL, clearing their seeds from memory. */
export function reap(now = Date.now()): number {
  let closed = 0;
  for (const [key, entry] of pool) {
    if (now - entry.lastUsed > CFG.walletTtlMs) {
      entry.unsubscribe();
      void entry.wallet.close().catch(() => {});
      pool.delete(key);
      closed++;
    }
  }
  return closed;
}

export async function closeAll(): Promise<void> {
  for (const [key, entry] of pool) {
    entry.unsubscribe();
    await entry.wallet.close().catch(() => {});
    pool.delete(key);
  }
}

export const poolSize = (): number => pool.size;
