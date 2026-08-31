/**
 * Shared Preprod wallet plumbing for the anchor scripts.
 *
 * Extracted from deploy-anchor.ts when a second script needed the same thing.
 * Every hard-won detail in here — the two disagreeing network ids, the
 * checkpointed sync, the balanceUnbound/finalize split, the hex coin keys —
 * was paid for once in that script, and a second copy would drift from it
 * silently. deploy-anchor.ts now imports this rather than owning it.
 */
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  appendFileSync,
  rmSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { resolve, dirname } from "node:path";
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
import { CompiledContract } from "@midnight-ntwrk/midnight-js-protocol/compact-js";
import { setNetworkId, getNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { WebSocket as NodeWebSocket } from "ws";
(globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWebSocket;
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
// ../ because this module sits in scripts/lib/ while its siblings are in
// scripts/. The SyncLiveness import was lost in the extraction and only
// surfaced at runtime, as "SyncLiveness is not defined" after a sync attempt.
import { unshieldedAddressForSeed } from "../unshielded-address.js";
import { SyncLiveness, type ObservedState } from "../sync-liveness.js";

// ../.. because this lives in scripts/lib/, one deeper than the script that
// used to own it. Getting this wrong resolves every path under scripts/.
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const CONTRACT_DIR = resolve(ROOT, "contracts/audit-anchor");
export const MANAGED = resolve(CONTRACT_DIR, "src/managed/audit-anchor");

function envLocal(): Record<string, string> {
  const p = resolve(ROOT, ".env.local");
  if (!existsSync(p)) return {};
  return Object.fromEntries(
    readFileSync(p, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && l.includes("="))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
}

export const E = { ...envLocal(), ...process.env } as Record<string, string>;
export const CFG = {
  indexer: E.MIDNIGHT_INDEXER_URL ?? "https://indexer.preprod.midnight.network/api/v4/graphql",
  indexerWs:
    E.MIDNIGHT_INDEXER_WS_URL ?? "wss://indexer.preprod.midnight.network/api/v4/graphql/ws",
  node: E.MIDNIGHT_NODE_URL ?? "https://rpc.preprod.midnight.network",
  proofServer: E.MIDNIGHT_PROOF_SERVER_URL ?? "http://127.0.0.1:6300",
};

/**
 * Sync checkpoint.
 *
 * A cold Preprod sync runs for the better part of an hour, and the wallet's
 * indexer connections drop often enough that three separate runs have now ended
 * wedged rather than finished — zero open sockets, no output, indistinguishable
 * from patience. The SDK offers no reconnect, so the only recovery is a fresh
 * facade; each sub-wallet exposes `serializeState()`/`restore()`, so we
 * checkpoint as we go and hand that state back on the next attempt. Without it
 * a drop at minute fifty costs all fifty minutes again, which is how the last
 * two attempts were lost.
 *
 * This holds wallet *state* — UTXOs and a sync tip, not keys — but it still
 * describes what this wallet holds, so it is gitignored beside .env.local.
 */
const CHECKPOINT = resolve(ROOT, ".sync-checkpoint.json");
/** No forward progress for this long means wedged, not slow. */
const STALL_MS = Number(E.MIDNIGHT_SYNC_STALL_MS ?? 300_000);
const MAX_SYNC_ATTEMPTS = Number(E.MIDNIGHT_SYNC_ATTEMPTS ?? 5);
const CHECKPOINT_EVERY_MS = 60_000;
const HEARTBEAT_MS = 20_000;
/** A reported disconnect this long is the drop itself, not a blip. */
const DISCONNECT_MS = Number(E.MIDNIGHT_DISCONNECT_MS ?? 90_000);
/** No state emission at all for this long — wider, since a restore can lag. */
const SILENCE_MS = Number(E.MIDNIGHT_SILENCE_MS ?? 270_000);

/**
 * Password protecting the local private-state store. Generated on first use and
 * appended to .env.local; the store holds the anchor secretKey and salt, so this
 * file is as sensitive as the wallet seeds.
 */
export function privateStorePassword(): string {
  const existing = E.MIDNIGHT_PRIVATE_STORE_PASSWORD;
  if (existing && existing.length >= 16) return existing;
  const generated = randomBytes(24).toString("base64url");
  appendFileSync(resolve(ROOT, ".env.local"), `MIDNIGHT_PRIVATE_STORE_PASSWORD=${generated}\n`);
  E.MIDNIGHT_PRIVATE_STORE_PASSWORD = generated;
  console.log("  ! generated MIDNIGHT_PRIVATE_STORE_PASSWORD -> .env.local (back it up)");
  return generated;
}

export async function preflight(): Promise<void> {
  if (!existsSync(resolve(MANAGED, "contract/index.js"))) {
    throw new Error(
      `compiled contract not found at ${MANAGED}. Run: cd contracts/audit-anchor && npm run compact`,
    );
  }
  const res = await fetch(CFG.proofServer).catch(() => null);
  if (!res) {
    throw new Error(
      `proof server unreachable at ${CFG.proofServer}. Start it:\n` +
        `  docker run -d -p 6300:6300 midnightntwrk/proof-server:8.1.0-arm64 -- midnight-proof-server --network preprod`,
    );
  }
  if (!E.MIDNIGHT_DEPLOYER_SEED) {
    throw new Error("MIDNIGHT_DEPLOYER_SEED not set. Run: npm run sync-wallets");
  }
}

export type Checkpoint = { shielded: string; unshielded: string; dust: string; savedAt: string };

export type WalletKeys = {
  shieldedSecretKeys: ReturnType<typeof ledger.ZswapSecretKeys.fromSeed>;
  dustSecretKey: ReturnType<typeof ledger.DustSecretKey.fromSeed>;
  unshieldedKeystore: ReturnType<typeof createKeystore>;
};

export type SyncedState = Awaited<ReturnType<WalletFacade["waitForSyncedState"]>>;

class StalledError extends Error {}

export function readCheckpoint(): Checkpoint | null {
  if (!existsSync(CHECKPOINT)) return null;
  try {
    const cp = JSON.parse(readFileSync(CHECKPOINT, "utf8")) as Checkpoint;
    // A half-written checkpoint should cost a cold sync, not the whole run.
    return cp.shielded && cp.unshielded && cp.dust ? cp : null;
  } catch {
    return null;
  }
}

export async function saveCheckpoint(wallet: WalletFacade): Promise<void> {
  const [shielded, unshielded, dust] = await Promise.all([
    wallet.shielded.serializeState(),
    wallet.unshielded.serializeState(),
    wallet.dust.serializeState(),
  ]);
  writeFileSync(
    CHECKPOINT,
    `${JSON.stringify({ shielded, unshielded, dust, savedAt: new Date().toISOString() })}\n`,
  );
}

/**
 * Build the facade and begin syncing. Given a checkpoint the three sub-wallets
 * are restored rather than started from keys, resuming at the saved tip.
 */
export async function buildWallet(k: WalletKeys, cp: Checkpoint | null): Promise<WalletFacade> {
  const connection = {
    networkId: getNetworkId(),
    indexerClientConnection: { indexerHttpUrl: CFG.indexer, indexerWsUrl: CFG.indexerWs },
  };
  const shieldedConfig = {
    ...connection,
    provingServerUrl: new URL(CFG.proofServer),
    relayURL: new URL(CFG.node.replace(/^http/, "ws")),
  };

  const wallet = await WalletFacade.init({
    configuration: {
      ...shieldedConfig,
      ...connection,
      txHistoryStorage: new NoOpTransactionHistoryStorage(),
      costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 },
    },
    shielded: (cfg: never) =>
      cp
        ? ShieldedWallet(cfg).restore(cp.shielded as never)
        : ShieldedWallet(cfg).startWithSecretKeys(k.shieldedSecretKeys),
    unshielded: (cfg: never) =>
      cp
        ? UnshieldedWallet(cfg).restore(cp.unshielded as never)
        : UnshieldedWallet(cfg).startWithPublicKey(PublicKey.fromKeyStore(k.unshieldedKeystore)),
    dust: (cfg: never) =>
      cp
        ? DustWallet(cfg).restore(cp.dust as never)
        : DustWallet(cfg).startWithSecretKey(
            k.dustSecretKey,
            ledger.LedgerParameters.initialParameters().dust,
          ),
  });
  await wallet.start(k.shieldedSecretKeys, k.dustSecretKey);
  return wallet;
}

/**
 * Resolve when synced; reject with StalledError when the sync stops advancing.
 *
 * The stall signal is the *absence of forward movement* in the progress
 * counters, not the absence of emissions: a dropped connection can leave the
 * observable emitting an unchanging state, which a liveness check keyed on
 * emissions alone would read as healthy.
 */
export function syncOrStall(wallet: WalletFacade): Promise<SyncedState> {
  return new Promise<SyncedState>((resolve, reject) => {
    const started = Date.now();
    const liveness = new SyncLiveness(
      { stallMs: STALL_MS, disconnectMs: DISCONNECT_MS, silenceMs: SILENCE_MS },
      started,
    );
    let lastLog = 0;
    let lastSave = Date.now();
    let saving = false;
    let settled = false;

    const sub = wallet.state().subscribe((raw) => {
      const st = raw as unknown as ObservedState;
      const now = Date.now();
      liveness.observe(st, now);

      if (now - lastLog >= HEARTBEAT_MS) {
        lastLog = now;
        const u = st.unshielded?.progress;
        const mins = ((now - started) / 60000).toFixed(1);
        const pct =
          u?.highestIndex && u.highestIndex > 0n
            ? `${((Number(u.appliedIndex ?? 0n) / Number(u.highestIndex)) * 100).toFixed(1)}%`
            : "?";
        console.log(
          `  +${mins}m unshielded ${pct}  coins=${st.unshielded?.availableCoins?.length ?? 0}` +
            `  conn=${liveness.connected ? "up" : "DOWN"}` +
            `${liveness.progressIsLive ? "" : "  [progress counters idle]"}`,
        );
      }

      // Checkpointing is best-effort: a failure costs resume speed on the next
      // attempt, and must not take down a sync that is otherwise healthy.
      if (!saving && now - lastSave >= CHECKPOINT_EVERY_MS) {
        saving = true;
        saveCheckpoint(wallet)
          .catch((e) => console.log(`  ! checkpoint failed (continuing): ${e?.message ?? e}`))
          .finally(() => {
            saving = false;
            lastSave = Date.now();
          });
      }
    });

    let watchdog: ReturnType<typeof setInterval> | undefined;
    const done = () => {
      settled = true;
      if (watchdog) clearInterval(watchdog);
      sub.unsubscribe();
    };

    watchdog = setInterval(() => {
      if (settled) return;
      const v = liveness.verdict(Date.now());
      if (v.kind === "stalled") {
        done();
        reject(new StalledError(v.reason));
      }
    }, 15_000);

    wallet.waitForSyncedState().then(
      (st) => {
        if (settled) return;
        done();
        resolve(st);
      },
      (e) => {
        if (settled) return;
        done();
        reject(e);
      },
    );
  });
}

/** Sync, restarting the facade on a stall, resuming from the last checkpoint. */
export async function syncWithRestarts(
  k: WalletKeys,
): Promise<{ wallet: WalletFacade; state: SyncedState }> {
  let checkpoint = readCheckpoint();
  let lastError: unknown;

  for (let attempt = 1; attempt <= MAX_SYNC_ATTEMPTS; attempt++) {
    console.log(
      checkpoint
        ? `  attempt ${attempt}/${MAX_SYNC_ATTEMPTS}: resuming from checkpoint (${checkpoint.savedAt})`
        : `  attempt ${attempt}/${MAX_SYNC_ATTEMPTS}: cold sync`,
    );

    let wallet: WalletFacade;
    try {
      wallet = await buildWallet(k, checkpoint);
    } catch (e) {
      // A checkpoint the SDK will not take would fail every remaining attempt
      // identically. Drop it and let the next one start cold.
      if (checkpoint) {
        console.log(`  ! checkpoint rejected (${(e as Error)?.message ?? e}) — discarding`);
        rmSync(CHECKPOINT, { force: true });
        checkpoint = null;
        lastError = e;
        continue;
      }
      throw e;
    }

    try {
      const state = await syncOrStall(wallet);
      console.log("  synced.");

      // Checkpoint at the tip, not just on the 60s timer.
      //
      // That timer only fires from inside syncOrStall, and a resume now reaches
      // `synced` before it elapses — so every run after the first resumed from
      // the same increasingly stale checkpoint and re-scanned a little more
      // chain each time. Resume was quietly degrading back toward a cold sync.
      // Best-effort: a failure here costs speed next time, never this run.
      await saveCheckpoint(wallet).catch((e) =>
        console.log(`  ! tip checkpoint failed (continuing): ${e?.message ?? e}`),
      );

      return { wallet, state };
    } catch (e) {
      lastError = e;
      console.log(`  ! sync attempt ${attempt} failed: ${(e as Error)?.message ?? e}`);
      await wallet.stop().catch(() => {});
      // Pick up whatever the heartbeat saved before it wedged.
      checkpoint = readCheckpoint();
      if (attempt < MAX_SYNC_ATTEMPTS) {
        const backoff = Math.min(30_000, 5_000 * attempt);
        console.log(`  retrying in ${backoff / 1000}s`);
        await new Promise((r) => setTimeout(r, backoff));
      }
    }
  }

  throw new Error(
    `sync failed after ${MAX_SYNC_ATTEMPTS} attempts: ${(lastError as Error)?.message ?? lastError}`,
  );
}
