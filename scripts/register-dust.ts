// Copyright (C) 2026 1Claw
// SPDX-License-Identifier: Apache-2.0

/**
 * Register a seed-derived wallet's NIGHT UTXOs for DUST generation on Preprod.
 *
 * DUST pays fees and does not appear merely because a wallet holds NIGHT: each
 * unshielded UTXO carries `registeredForDustGeneration`, and the faucet hands
 * out NIGHT with it false. This submits the registration transaction — the same
 * one Lace's "Generate tDUST" button sends — for a wallet we hold the seed to,
 * so the wallet that ends up able to pay fees is also the one deploy-anchor.ts
 * drives.
 *
 * The API lives in `@midnightntwrk/wallet-sdk` — note the scope has no hyphen,
 * and is a different package from `@midnight-ntwrk/wallet`. Looking only in the
 * hyphenated scope is what convinced us no registration API existed.
 *
 * Requires the proof server on :6300 — registration is a proved transaction.
 *
 *   npx tsx scripts/register-dust.ts             # deployer seed
 *   npx tsx scripts/register-dust.ts agent       # agent seed
 */
import { WebSocket } from "ws";
// The SDK's indexer clients expect a global WebSocket, which Node does not
// provide in the shape they want.
(globalThis as unknown as { WebSocket: unknown }).WebSocket = WebSocket;

import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import * as Rx from "rxjs";
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
  DustAddress,
  MidnightBech32m,
} from "@midnightntwrk/wallet-sdk";
import * as ledger from "@midnight-ntwrk/midnight-js-protocol/ledger";
import { unshieldedToken } from "@midnight-ntwrk/midnight-js-protocol/ledger";
import type { ObservedState } from "./sync-liveness.js";
import { setNetworkId, getNetworkId } from "@midnight-ntwrk/midnight-js-network-id";

setNetworkId("preprod");

const CONFIG = {
  indexerHttpUrl: "https://indexer.preprod.midnight.network/api/v4/graphql",
  indexerWsUrl: "wss://indexer.preprod.midnight.network/api/v4/graphql/ws",
  node: "https://rpc.preprod.midnight.network",
  proofServer: process.env.MIDNIGHT_PROOF_SERVER_URL ?? "http://localhost:6300",
};

const which = (process.argv[2] ?? "deployer").toLowerCase();
const SEED_KEY = which === "agent" ? "MIDNIGHT_AGENT_SEED" : "MIDNIGHT_DEPLOYER_SEED";

function seedFromEnvLocal(): string {
  const env = Object.fromEntries(
    readFileSync(new URL("../.env.local", import.meta.url), "utf8")
      .split("\n")
      .filter((l) => l.includes("=") && !l.startsWith("#"))
      .map((l) => {
        const i = l.indexOf("=");
        return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")];
      }),
  );
  const seed = env[SEED_KEY];
  if (!seed) throw new Error(`${SEED_KEY} not found in .env.local`);
  return seed;
}

/** Three roles, one derivation pass: Zswap (shielded), NightExternal, Dust. */
function deriveKeys(seedHex: string) {
  const hd = HDWallet.fromSeed(Buffer.from(seedHex, "hex"));
  if (hd.type !== "seedOk") throw new Error("invalid seed");
  const result = hd.hdWallet
    .selectAccount(0)
    .selectRoles([Roles.Zswap, Roles.NightExternal, Roles.Dust])
    .deriveKeysAt(0);
  if (result.type !== "keysDerived") throw new Error("key derivation failed");
  // Zero the HD tree once the three keys are out of it.
  hd.hdWallet.clear();
  return result.keys;
}

/** The slice of FacadeState this script waits on. */
type SyncedDustState = { isSynced: boolean; dust: { balance(d: Date): bigint } };

const night = (raw: bigint) => `${raw / 1_000_000n}.${(raw % 1_000_000n).toString().padStart(6, "0")}`;
const dust = (raw: bigint) =>
  `${raw / 1_000_000_000_000_000n}.${(raw % 1_000_000_000_000_000n).toString().padStart(15, "0")}`;

async function main() {
  const seed = seedFromEnvLocal();
  const keys = deriveKeys(seed);

  const shieldedSecretKeys = ledger.ZswapSecretKeys.fromSeed(keys[Roles.Zswap]);
  const dustSecretKey = ledger.DustSecretKey.fromSeed(keys[Roles.Dust]);
  const unshieldedKeystore = createKeystore(keys[Roles.NightExternal], getNetworkId());

  const shieldedConfig = {
    networkId: getNetworkId(),
    indexerClientConnection: {
      indexerHttpUrl: CONFIG.indexerHttpUrl,
      indexerWsUrl: CONFIG.indexerWsUrl,
    },
    provingServerUrl: new URL(CONFIG.proofServer),
    relayURL: new URL(CONFIG.node.replace(/^http/, "ws")),
  };
  const unshieldedConfig = {
    networkId: getNetworkId(),
    indexerClientConnection: {
      indexerHttpUrl: CONFIG.indexerHttpUrl,
      indexerWsUrl: CONFIG.indexerWsUrl,
    },
    txHistoryStorage: new NoOpTransactionHistoryStorage(),
  };
  const dustConfig = {
    ...shieldedConfig,
    costParameters: { additionalFeeOverhead: 300_000_000_000_000n, feeBlocksMargin: 5 },
  };

  console.log(`[${which}] building facade …`);
  const wallet = await WalletFacade.init({
    configuration: { ...shieldedConfig, ...unshieldedConfig, ...dustConfig },
    shielded: (cfg: never) => ShieldedWallet(cfg).startWithSecretKeys(shieldedSecretKeys),
    unshielded: (cfg: never) =>
      UnshieldedWallet(cfg).startWithPublicKey(PublicKey.fromKeyStore(unshieldedKeystore)),
    dust: (cfg: never) =>
      DustWallet(cfg).startWithSecretKey(
        dustSecretKey,
        ledger.LedgerParameters.initialParameters().dust,
      ),
  });

  await wallet.start(shieldedSecretKeys, dustSecretKey);
  console.log(`[${which}] address ${unshieldedKeystore.getBech32Address()}`);
  console.log(`[${which}] syncing (cold wallets take a while) …`);

  // Heartbeat. A cold sync can run for an hour, and without this a hang and a
  // slow sync look identical — which is exactly how the first attempt burned 55
  // minutes before we noticed it had lost its connection and stopped.
  const started = Date.now();
  const beat = wallet
    .state()
    .pipe(Rx.throttleTime(20_000))
    // Cast rather than annotate the parameter: FacadeState's availableCoins is
    // `readonly UtxoWithMeta[]`, which is not assignable to a mutable
    // `unknown[]`, so a narrower parameter type fails the subscribe overload.
    // Same treatment as deploy-anchor.ts, and the same shared type.
    .subscribe((raw) => {
      const st = raw as unknown as ObservedState;
      // These are prototype getters, not own properties — Object.entries() does
      // not show them, which briefly convinced us the state shape had changed.
      // The fields are appliedIndex/highestIndex; `synced`/`total` were a guess
      // and, being absent, printed "?" for every sync this script ever ran.
      const mins = ((Date.now() - started) / 60000).toFixed(1);
      const u = st.unshielded?.progress;
      const pct =
        u?.highestIndex && u.highestIndex > 0n
          ? `${((Number(u.appliedIndex ?? 0n) / Number(u.highestIndex)) * 100).toFixed(1)}%`
          : "?";
      const coins = st.unshielded?.availableCoins?.length ?? 0;
      const conn = u?.isConnected === false ? " conn=DOWN" : "";
      console.log(`[${which}] +${mins}m unshielded ${pct}  coins=${coins}${conn}`);
    });

  const state = await wallet.waitForSyncedState();
  beat.unsubscribe();
  const balance = state.unshielded.balances[unshieldedToken().raw] ?? 0n;
  console.log(`[${which}] NIGHT ${night(balance)}`);
  if (balance === 0n) {
    console.log(`[${which}] no NIGHT — fund the address above at the Preprod faucet first.`);
    await wallet.stop();
    process.exit(1);
  }

  const unregistered = state.unshielded.availableCoins.filter(
    (c: { meta?: { registeredForDustGeneration?: boolean } }) =>
      c.meta?.registeredForDustGeneration !== true,
  );
  console.log(
    `[${which}] ${state.unshielded.availableCoins.length} coin(s), ${unregistered.length} unregistered`,
  );

  if (unregistered.length === 0) {
    console.log(`[${which}] already registered — nothing to submit.`);
  } else {
    const target = String(DustAddress.encodePublicKey(getNetworkId(), state.dust.publicKey));
    const dustReceiver = MidnightBech32m.parse(target).decode(DustAddress, getNetworkId());

    console.log(`[${which}] registering ${unregistered.length} coin(s) → ${target.slice(0, 28)}…`);
    const recipe = await wallet.registerNightUtxosForDustGeneration(
      unregistered,
      unshieldedKeystore.getPublicKey(),
      (payload: never) => unshieldedKeystore.signData(payload),
      dustReceiver,
    );
    const finalized = await wallet.finalizeRecipe(recipe);
    const txId = await wallet.submitTransaction(finalized);
    console.log(`[${which}] submitted: ${txId}`);
  }

  console.log(`[${which}] waiting for DUST to appear …`);
  await Rx.firstValueFrom(
    wallet.state().pipe(
      Rx.throttleTime(5_000),
      // One type through the pipe. Two filters each declaring their own narrow
      // shape do not chain — rxjs threads the first operator's output type into
      // the second, and `{ isSynced }` has no `dust`.
      Rx.filter((s: SyncedDustState) => s.isSynced && s.dust.balance(new Date()) > 0n),
    ),
  );
  const finalState = await Rx.firstValueFrom(wallet.state());
  console.log(`[${which}] DUST ${dust(finalState.dust.balance(new Date()))}`);
  console.log(`[${which}] done — deploy-anchor.ts can now pay fees with this seed.`);

  await wallet.stop();
}

main().catch((e) => {
  console.error("registration failed:", e);
  process.exit(1);
});
