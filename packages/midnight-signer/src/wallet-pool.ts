// Copyright (C) 2026 1Claw
// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  HDWallet,
  Roles,
  WalletFacade,
  ShieldedWallet,
  DustWallet,
  UnshieldedWallet,
  createKeystore,
  PublicKey,
  NoOpTransactionHistoryStorage,
} from "@midnightntwrk/wallet-sdk";
import * as ledger from "@midnight-ntwrk/midnight-js-protocol/ledger";
import { setNetworkId, getNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { CFG } from "./config.js";

/**
 * Keeps built wallets warm, keyed by seed.
 *
 * Building a wallet opens indexer connections and takes seconds, so building one
 * per request would make signing unusable. Against that, this process holds raw
 * seeds in memory, so entries expire rather than living for the process
 * lifetime. Keys are a hash of the seed — the seed itself is never used as a map
 * key, logged, or included in an error.
 *
 * WalletFacade, not WalletBuilder. `@midnight-ntwrk/wallet` is Zswap-only: it
 * cannot see unshielded NIGHT, has no DustWallet, and therefore cannot assemble
 * a fee-paying transaction at all — it fails with "expected instance of
 * LedgerParameters". deploy-anchor.ts hit exactly this and moved to the facade;
 * the sidecar did not follow, which is why its DUST balance was unknowable and
 * it could not broadcast on Preprod.
 *
 * The facade carries all three sub-wallets, so balances and fees both work.
 */

// Two network identifiers at two layers, and they disagree: midnight-js keeps a
// string and wants "preprod"; zswap's NetworkId enum has no Preprod variant.
// Setting this once at module load is what makes address encodings line up.
setNetworkId("preprod");

export type WalletState = Record<string, unknown>;

export type Entry = {
  wallet: WalletFacade;
  /** Needed again at signing time, so derived once and kept with the wallet. */
  shieldedSecretKeys: ReturnType<typeof ledger.ZswapSecretKeys.fromSeed>;
  dustSecretKey: ReturnType<typeof ledger.DustSecretKey.fromSeed>;
  unshieldedKeystore: ReturnType<typeof createKeystore>;
  latest: WalletState | null;
  lastUsed: number;
  unsubscribe: () => void;
  /** Stops the periodic checkpoint writer for this wallet. */
  stopCheckpoints: () => void;
  /**
   * Set once this wallet has been used to build a transaction, and never
   * cleared. See `markSpent`.
   */
  spent: boolean;
};

const pool = new Map<string, Entry>();

const keyFor = (seedHex: string): string =>
  createHash("sha256").update(seedHex).digest("hex").slice(0, 32);

/**
 * Sync checkpoints, one file per wallet.
 *
 * A cold Preprod sync is ~1.47M indices at roughly 300/s — about 80 minutes.
 * That is survivable for a deploy script and completely unusable for an HTTP
 * handler, so without this every signer restart would report a DUST balance of
 * zero forever and never be able to pay a fee. `deploy-anchor.ts` already
 * solved this; the same serializeState()/restore() pair is used here so the two
 * stay compatible.
 *
 * Named by the same seed hash the pool is keyed by — never the seed.
 */
// Resolved against this file, not the cwd: the signer is started from a couple
// of different directories, and a checkpoint written to the wrong one silently
// costs a full resync rather than failing.
const CHECKPOINT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", CFG.checkpointDir);

type Checkpoint = { shielded: string; unshielded: string; dust: string; savedAt: string };

const checkpointPath = (key: string): string => resolve(CHECKPOINT_DIR, `${key}.json`);

function readCheckpoint(key: string): Checkpoint | null {
  const path = checkpointPath(key);
  if (!existsSync(path)) return null;
  try {
    const cp = JSON.parse(readFileSync(path, "utf8")) as Checkpoint;
    // A half-written checkpoint should cost a cold sync, not the whole request.
    if (!cp?.shielded || !cp?.unshielded || !cp?.dust) return null;
    return cp;
  } catch {
    return null;
  }
}

async function saveCheckpoint(key: string, wallet: WalletFacade): Promise<void> {
  const [shielded, unshielded, dust] = await Promise.all([
    wallet.shielded.serializeState(),
    wallet.unshielded.serializeState(),
    wallet.dust.serializeState(),
  ]);
  mkdirSync(CHECKPOINT_DIR, { recursive: true });
  // Written aside then renamed: the dust blob is ~11MB, and a crash mid-write
  // would otherwise leave a truncated file that costs an 80-minute resync.
  const path = checkpointPath(key);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify({ shielded, unshielded, dust, savedAt: new Date().toISOString() }));
  renameSync(tmp, path);
}

type Material = {
  shieldedSecretKeys: ReturnType<typeof ledger.ZswapSecretKeys.fromSeed>;
  dustSecretKey: ReturnType<typeof ledger.DustSecretKey.fromSeed>;
  unshieldedKeystore: ReturnType<typeof createKeystore>;
};

/**
 * Build the facade, resuming from a checkpoint when one exists.
 *
 * With a checkpoint the three sub-wallets are restored rather than started from
 * keys, which picks the sync up at the saved tip instead of genesis.
 */
async function buildFacade(cp: Checkpoint | null, material: Material): Promise<WalletFacade> {
  const { shieldedSecretKeys, dustSecretKey, unshieldedKeystore } = material;

  const connection = {
    networkId: getNetworkId(),
    indexerClientConnection: { indexerHttpUrl: CFG.indexer, indexerWsUrl: CFG.indexerWs },
  };

  return WalletFacade.init({
    configuration: {
      ...connection,
      provingServerUrl: new URL(CFG.proofServer),
      relayURL: new URL(CFG.node.replace(/^http/, "ws")),
      txHistoryStorage: new NoOpTransactionHistoryStorage(),
      costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 },
    },
    // Parameter types are inferred, not annotated. Writing `(cfg: never)` here
    // (as deploy-anchor.ts does, under looser flags) drives the facade's TConfig
    // inference to `never` in contravariant position, and the whole
    // `configuration` object is then rejected as not assignable to `never`.
    shielded: (cfg) =>
      cp
        ? ShieldedWallet(cfg).restore(cp.shielded as never)
        : ShieldedWallet(cfg).startWithSecretKeys(shieldedSecretKeys),
    unshielded: (cfg) =>
      cp
        ? UnshieldedWallet(cfg).restore(cp.unshielded as never)
        : UnshieldedWallet(cfg).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: (cfg) =>
      cp
        ? DustWallet(cfg).restore(cp.dust as never)
        : DustWallet(cfg).startWithSecretKey(
            dustSecretKey,
            ledger.LedgerParameters.initialParameters().dust,
          ),
  });
}

export async function acquire(seedHex: string): Promise<Entry> {
  const key = keyFor(seedHex);
  const existing = pool.get(key);
  if (existing) {
    existing.lastUsed = Date.now();
    return existing;
  }

  const hd = HDWallet.fromSeed(Buffer.from(seedHex, "hex"));
  if (hd.type !== "seedOk") throw new Error("invalid seed");
  const derived = hd.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  if (derived.type !== "keysDerived") throw new Error("key derivation failed");
  const keys = derived.keys;
  // Zero the HD tree once the three keys are out of it.
  hd.hdWallet.clear();

  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], getNetworkId());

  const cp = readCheckpoint(key);
  const wallet = await buildFacade(cp, {
    shieldedSecretKeys,
    dustSecretKey,
    unshieldedKeystore,
  }).catch(async (e) => {
    // A checkpoint the SDK will not take would otherwise fail every future
    // request for this seed, so it is discarded once and the cold path retried.
    if (!cp) throw e;
    console.log(`[midnight-signer] checkpoint rejected (${(e as Error)?.message ?? e}) — resyncing`);
    return buildFacade(null, { shieldedSecretKeys, dustSecretKey, unshieldedKeystore });
  });
  await wallet.start(shieldedSecretKeys, dustSecretKey);

  const entry: Entry = {
    wallet,
    shieldedSecretKeys,
    dustSecretKey,
    unshieldedKeystore,
    latest: null,
    lastUsed: Date.now(),
    unsubscribe: () => {},
    stopCheckpoints: () => {},
    spent: false,
  };
  const sub = wallet.state().subscribe((s: unknown) => {
    entry.latest = s as WalletState;
  });
  entry.unsubscribe = () => sub.unsubscribe();

  // Checkpoint as the sync advances, not only at shutdown: a signer killed
  // mid-sync would otherwise resume from wherever it last happened to stop
  // cleanly, and on this chain that difference is measured in tens of minutes.
  let saving = false;
  const timer = setInterval(() => {
    if (saving) return;
    // See isCheckpointable: saving at the wrong moment does not merely produce
    // a stale checkpoint, it produces one that can never recover.
    if (!isCheckpointable(entry)) return;
    saving = true;
    void saveCheckpoint(key, wallet)
      .catch((e) => console.log(`[midnight-signer] checkpoint failed (continuing): ${e?.message ?? e}`))
      .finally(() => {
        saving = false;
      });
  }, CFG.checkpointEveryMs);
  timer.unref();
  entry.stopCheckpoints = () => clearInterval(timer);

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
      entry.stopCheckpoints();
      // Checkpoint before dropping it, so the next request for this seed
      // resumes here rather than at the last periodic save — but only if it is
      // caught up, for the same reason the periodic writer checks.
      const evicted = entry;
      void (isCheckpointable(entry)
        ? saveCheckpoint(key, entry.wallet).catch(() => {})
        : Promise.resolve()
      ).finally(() => void evicted.wallet.stop().catch(() => {}));
      pool.delete(key);
      closed++;
    }
  }
  return closed;
}

export async function closeAll(): Promise<void> {
  for (const [key, entry] of pool) {
    entry.unsubscribe();
    entry.stopCheckpoints();
    if (isCheckpointable(entry)) await saveCheckpoint(key, entry.wallet).catch(() => {});
    await entry.wallet.stop().catch(() => {});
    pool.delete(key);
  }
}

/** SyncProgress, as reported by each sub-wallet. Numeric fields arrive as bigint. */
type Progress = {
  appliedIndex?: bigint;
  highestIndex?: bigint;
  highestRelevantWalletIndex?: bigint;
  isConnected?: boolean;
};

const progressOf = (state: WalletState, sub: string): Progress =>
  ((state as Record<string, { progress?: Progress }>)[sub]?.progress ?? {}) as Progress;

/**
 * Whether the wallet has genuinely caught up.
 *
 * Deliberately not `state.isSynced`. That flag compares applied against the
 * highest known index, and immediately after a checkpoint restore the indexer
 * connection is not up yet: the restored `appliedIndex` is already in the
 * millions while the highest known index is still zero, so "applied >= highest"
 * is trivially true. The wallet reports itself synced while its dust state is
 * still empty — which is how a wallet holding 4e18 DUST came back as `dust: 0`
 * and signing failed with "could not balance dust".
 *
 * `highestIndex` is *not* the tip to compare against: Preprod never populates
 * it (scripts/sync-liveness.ts documents the same discovery, arrived at the
 * hard way). `highestRelevantWalletIndex` is the field that actually moves.
 *
 * The unshielded sub-wallet is held to a weaker rule on purpose: it reports
 * `isConnected` but no indices at all, so requiring progress from it can never
 * be satisfied and every wallet would look permanently unsynced.
 */
export function isCaughtUp(state: WalletState): boolean {
  // Fees are paid from dust, and shielded coins are what a recipe spends, so
  // both of these must have reached the tip before any balance is meaningful.
  const indexed = ["shielded", "dust"].every((sub) => {
    const p = progressOf(state, sub);
    if (!p.isConnected) return false;
    const tip = p.highestRelevantWalletIndex ?? 0n;
    // A zero tip means the indexer has not said where the chain ends yet, so
    // there is nothing to be caught up *to*.
    if (tip <= 0n) return false;
    return (p.appliedIndex ?? 0n) >= tip;
  });

  return indexed && progressOf(state, "unshielded").isConnected === true;
}

/**
 * Whether the wallet is holding coins reserved for a transaction it has not
 * broadcast.
 *
 * Building a recipe — not broadcasting one, merely building it — moves the dust
 * coin from `availableCoins` to `pendingCoins` and drops the reported balance
 * to zero. That is fine in memory and fatal on disk: serializing that state
 * persists the reservation, and a wallet restored from it reports `dust: 0`
 * permanently, because the coin is never rescanned and the pending spend is
 * never resolved. A single checkpoint taken at the wrong moment therefore
 * bricks the wallet's fee-paying ability for good.
 *
 * Measured directly: before a recipe, dust 4.07e18 / available 1 / pending 0;
 * immediately after, dust 0 / available 0 / pending 1.
 */
export function hasPendingSpends(state: WalletState): boolean {
  const dust = (state as { dust?: { pendingCoins?: readonly unknown[] } }).dust;
  return (dust?.pendingCoins ?? []).length > 0;
}

/**
 * Mark a wallet as having built a transaction, permanently barring it from
 * being checkpointed.
 *
 * This is a flag rather than a check of the wallet's own pending state because
 * the check loses a race it cannot win: the guard reads the latest *emitted*
 * state, while the writer serializes the *live* wallet. Between the recipe
 * reserving the dust coin and the subscription emitting a state that shows it,
 * a periodic write serializes a reserved wallet while the snapshot still looks
 * clean. That happened, and the resulting checkpoint reported dust 0 forever.
 *
 * Never cleared: once a recipe exists the wallet's persisted state is unsafe
 * for the rest of its life in the pool, and the checkpoint on disk — written
 * before the recipe — is already the better one to resume from.
 */
export function markSpent(entry: Entry): void {
  entry.spent = true;
}

/**
 * Whether this entry is safe to persist as a checkpoint.
 *
 * Every clause here was learned by bricking a wallet: an unsynced state saves a
 * scan position past coins it never recorded, and a state with a reservation —
 * whether observed or merely possible — saves a spend that never clears. In
 * both cases the wallet returns reporting `dust: 0` permanently, because the
 * coin is never rescanned.
 */
export function isCheckpointable(entry: Entry): boolean {
  if (entry.spent) return false;
  const state = entry.latest;
  return state != null && isCaughtUp(state) && !hasPendingSpends(state);
}

/**
 * Wait for the wallet to finish catching up, bounded.
 *
 * `firstState` returns the *first* emitted state, which after a restore is the
 * checkpoint's stale tip: DUST reads 0 there and balances are empty. Reporting
 * that as a balance is the exact mistake this migration set out to fix, so
 * anything that reads balances waits, and if the wait runs out says so rather
 * than passing the stale number off as a measurement.
 *
 * From a warm checkpoint catching up takes seconds; from cold it is closer to
 * an hour, which is why this reports rather than blocks indefinitely.
 */
export async function syncedState(
  entry: Entry,
  timeoutMs = 90_000,
): Promise<{ state: WalletState; synced: boolean }> {
  const state = await firstState(entry);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const latest = entry.latest ?? state;
    if (isCaughtUp(latest)) return { state: latest, synced: true };
    await new Promise((r) => setTimeout(r, 500));
  }
  return { state: entry.latest ?? state, synced: false };
}

export const poolSize = (): number => pool.size;
