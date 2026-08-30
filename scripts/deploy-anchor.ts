/**
 * Deploy the AuditAnchor contract to Midnight Preprod.
 *
 * Requires:
 *   - the proof server running (docker, port 6300) — deployment proves a circuit
 *   - the deployer wallet funded with NIGHT *and* holding accrued DUST
 *
 * Writes the resulting contract address to the anchor viewer's config so the
 * frontend does not need it pasted in by hand.
 *
 *   npm run deploy:anchor
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
import { deployContract } from "@midnight-ntwrk/midnight-js-contracts";
import { CompiledContract } from "@midnight-ntwrk/midnight-js-protocol/compact-js";
import { setNetworkId, getNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { WebSocket as NodeWebSocket } from "ws";
(globalThis as unknown as { WebSocket: unknown }).WebSocket = NodeWebSocket;
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import { unshieldedAddressForSeed } from "./unshielded-address.js";
import { SyncLiveness, type ObservedState } from "./sync-liveness.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT_DIR = resolve(ROOT, "contracts/audit-anchor");
const MANAGED = resolve(CONTRACT_DIR, "src/managed/audit-anchor");
// public/, not the app root: Vite serves and copies only publicDir, so a
// config written beside package.json 404s in dev and never reaches dist.
const VIEWER_CONFIG = resolve(ROOT, "demo/anchor-viewer/public/config.json");

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

const E = { ...envLocal(), ...process.env } as Record<string, string>;
const CFG = {
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
function privateStorePassword(): string {
  const existing = E.MIDNIGHT_PRIVATE_STORE_PASSWORD;
  if (existing && existing.length >= 16) return existing;
  const generated = randomBytes(24).toString("base64url");
  appendFileSync(resolve(ROOT, ".env.local"), `MIDNIGHT_PRIVATE_STORE_PASSWORD=${generated}\n`);
  E.MIDNIGHT_PRIVATE_STORE_PASSWORD = generated;
  console.log("  ! generated MIDNIGHT_PRIVATE_STORE_PASSWORD -> .env.local (back it up)");
  return generated;
}

async function preflight(): Promise<void> {
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

type Checkpoint = { shielded: string; unshielded: string; dust: string; savedAt: string };

type WalletKeys = {
  shieldedSecretKeys: ReturnType<typeof ledger.ZswapSecretKeys.fromSeed>;
  dustSecretKey: ReturnType<typeof ledger.DustSecretKey.fromSeed>;
  unshieldedKeystore: ReturnType<typeof createKeystore>;
};

type SyncedState = Awaited<ReturnType<WalletFacade["waitForSyncedState"]>>;

class StalledError extends Error {}

function readCheckpoint(): Checkpoint | null {
  if (!existsSync(CHECKPOINT)) return null;
  try {
    const cp = JSON.parse(readFileSync(CHECKPOINT, "utf8")) as Checkpoint;
    // A half-written checkpoint should cost a cold sync, not the whole run.
    return cp.shielded && cp.unshielded && cp.dust ? cp : null;
  } catch {
    return null;
  }
}

async function saveCheckpoint(wallet: WalletFacade): Promise<void> {
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
async function buildWallet(k: WalletKeys, cp: Checkpoint | null): Promise<WalletFacade> {
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
function syncOrStall(wallet: WalletFacade): Promise<SyncedState> {
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
async function syncWithRestarts(
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

async function main(): Promise<void> {
  await preflight();
  // Two different network identifiers, at two different layers, and they do not
  // agree. midnight-js keeps a *string* in module state and wants "preprod";
  // zswap's NetworkId enum has no Preprod variant, so the wallet takes TestNet.
  // Setting the midnight-js one to "test" encoded addresses with the test HRP
  // and found no coins, because the funded UTXOs live under preprod.
  setNetworkId("preprod");
  console.log("Deploying AuditAnchor to Preprod");

  // WalletFacade, not WalletBuilder. The old @midnight-ntwrk/wallet builder is
  // Zswap-only: it reported `coins: 0` for a funded wallet, because faucet NIGHT
  // is unshielded, and then failed with "expected instance of LedgerParameters"
  // because it could not assemble a fee-paying transaction without the DUST
  // wallet. The facade carries all three (shielded, unshielded, dust), which is
  // what scripts/register-dust.ts proved works against Preprod.
  const hd = HDWallet.fromSeed(Buffer.from(E.MIDNIGHT_DEPLOYER_SEED, "hex"));
  if (hd.type !== "seedOk") throw new Error("invalid MIDNIGHT_DEPLOYER_SEED");
  const derived = hd.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  if (derived.type !== "keysDerived") throw new Error("key derivation failed");
  const keys = derived.keys;
  hd.hdWallet.clear();

  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], getNetworkId());

  const unshielded = String(unshieldedKeystore.getBech32Address());
  console.log(`  unshielded: ${unshielded}`);
  console.log("  syncing (cold wallets take a while) …");

  const { wallet, state } = await syncWithRestarts({
    shieldedSecretKeys,
    dustSecretKey,
    unshieldedKeystore,
  });

  const dustBalance = state.dust.balance(new Date());
  console.log(`  DUST: ${dustBalance}`);
  if (dustBalance === 0n) {
    throw new Error(
      "no DUST — run `npx tsx scripts/register-dust.ts` first; fees cannot be paid without it",
    );
  }

  const compiled = (await import(resolve(MANAGED, "contract/index.js"))) as {
    Contract: unknown;
  };
  const { witnesses, createAuditAnchorPrivateState } = (await import(
    resolve(CONTRACT_DIR, "src/witnesses.ts")
  )) as typeof import("../contracts/audit-anchor/src/witnesses.js");

  // deployContract takes a *CompiledContract*, not `new Contract(witnesses)`.
  // Passing the raw contract is what made compact-js fail inside
  // getContractContext: it looks for metadata that only the CompiledContract
  // wrapper carries. Pattern taken from midnightntwrk/example-bboard.
  const compiledContract = CompiledContract.make("AuditAnchor", compiled.Contract as never).pipe(
    CompiledContract.withWitnesses(witnesses as never),
    CompiledContract.withCompiledFileAssets(MANAGED),
  );

  const zkConfig = new NodeZkConfigProvider(MANAGED);

  const providers = {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: "audit-anchor",
      // Scopes the store per wallet so two deployers on one machine cannot read
      // each other's private state.
      // Scopes the private-state store to this wallet. Under the facade the
      // address lives on state.shielded, not at the top level as the old
      // builder had it — leaving it undefined fails with "accountId is
      // required", which reads like a config omission rather than a shape
      // change.
      // coinPublicKeyString(), not String(address): ShieldedAddress has no
      // toString override either, so this key was the constant "[object
      // Object]" — every wallet on the machine shared one private-state store,
      // which is the opposite of what the comment above promises and would let
      // a second deployer read and overwrite the first's secretKey and salt.
      accountId: state.shielded.address.coinPublicKeyString(),
      // The private-state store is encrypted at rest. The password is generated
      // once into .env.local rather than hard-coded — losing it means losing the
      // contract's private state (secretKey, salt, lastHead), which cannot be
      // recovered from the ledger since only commitments are published.
      privateStoragePasswordProvider: () => Promise.resolve(privateStorePassword()),
    }),
    publicDataProvider: indexerPublicDataProvider(CFG.indexer, CFG.indexerWs),
    zkConfigProvider: zkConfig,
    // The zk config provider is the *second* argument, not an option: without
    // it the provider has no circuit assets to prove against, and the failure
    // lands at deploy time — after the hour-long sync, not before it.
    proofProvider: httpClientProofProvider(CFG.proofServer, zkConfig),
    walletProvider: {
      // The *legacy* hex forms, not the bech32m display forms: the protocol
      // encodes these into a bech32 string with a 90-char cap, and the bech32m
      // address is 118 chars — which surfaced as "invalid string length 118".
      //
      // toHexString(), not String(): these are class instances with no toString
      // override, so String() yields the literal "[object Object]" — which is
      // what has been handed to midnight-js as the coin public key. The type is
      // just `string`, so nothing downstream rejected it at the boundary.
      coinPublicKey: state.shielded.coinPublicKey.toHexString(),
      encryptionPublicKey: state.shielded.encryptionPublicKey.toHexString(),
      getCoinPublicKey: () => state.shielded.coinPublicKey.toHexString(),
      getEncryptionPublicKey: () => state.shielded.encryptionPublicKey.toHexString(),
      // The facade balances into a *recipe*, then finalizes it — there is no
      // single balanceTransaction as the old builder had. `all` so the DUST
      // that pays the fee is balanced alongside the shielded side.
      //
      // balanceUnbound-, not balanceFinalized-: WalletProvider.balanceTx is
      // handed an UnboundTransaction, and balanceFinalizedTransaction refuses
      // at the door unless every intent is already signed — which surfaced as
      // "Intent with id 1 is not bound", naming neither the method nor the
      // mismatch. Binding happens here, between balancing and finalizing,
      // because the transaction is built through midnight-js rather than
      // through the wallet's own helpers, which take a signing callback up
      // front the way register-dust.ts does.
      balanceTx: async (tx: never, ttl?: Date) => {
        const recipe = await wallet.balanceUnboundTransaction(
          tx,
          { shieldedSecretKeys, dustSecretKey },
          { ttl: ttl ?? new Date(Date.now() + 3_600_000), tokenKindsToBalance: "all" },
        );
        const signed = await wallet.signRecipe(recipe, (data: never) =>
          unshieldedKeystore.signData(data),
        );
        return (await wallet.finalizeRecipe(signed)) as never;
      },
    },
    midnightProvider: {
      submitTx: (tx: never) => wallet.submitTransaction(tx) as never,
    },
  } as never;

  const secretKey = crypto.getRandomValues(new Uint8Array(32));
  const registrationSalt = crypto.getRandomValues(new Uint8Array(32));

  console.log("  proving + deploying (this takes a minute)…");
  const deployed = await deployContract(providers, {
    compiledContract,
    privateStateId: "audit-anchor",
    initialPrivateState: createAuditAnchorPrivateState(secretKey, registrationSalt),
  } as never);

  const address = (deployed as { deployTxData: { public: { contractAddress: string } } })
    .deployTxData.public.contractAddress;

  console.log(`\n  contract address: ${address}`);

  mkdirSync(dirname(VIEWER_CONFIG), { recursive: true });
  writeFileSync(
    VIEWER_CONFIG,
    `${JSON.stringify({ contractAddress: address, network: "preprod", indexer: CFG.indexer }, null, 2)}\n`,
  );
  console.log(`  wrote ${VIEWER_CONFIG}`);
  console.log("\n  Record this address in the README for judging.");

  await wallet.stop();
}

main().catch((e) => {
  // The message alone is not enough to place a failure like "bech32.decode
  // input: printable ASCII expected", which names neither the caller nor the
  // value. A stack costs nothing on a path that is already exiting non-zero.
  console.error(`\ndeploy failed: ${e?.message ?? e}`);
  if (e?.stack) console.error(`\n${e.stack}`);
  if (e?.cause) console.error(`\ncaused by: ${e.cause?.stack ?? e.cause}`);
  process.exit(1);
});
