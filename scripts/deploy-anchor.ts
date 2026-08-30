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
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from "node:fs";
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
        `  docker run -d -p 6300:6300 midnightntwrk/proof-server:9.0.0-rc.7-arm64 -- midnight-proof-server --network testnet`,
    );
  }
  if (!E.MIDNIGHT_DEPLOYER_SEED) {
    throw new Error("MIDNIGHT_DEPLOYER_SEED not set. Run: npm run sync-wallets");
  }
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

  const unshielded = String(unshieldedKeystore.getBech32Address());
  console.log(`  unshielded: ${unshielded}`);
  console.log("  syncing (cold wallets take a while) …");
  const state = await wallet.waitForSyncedState();

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
      accountId: String(state.shielded.address),
      // The private-state store is encrypted at rest. The password is generated
      // once into .env.local rather than hard-coded — losing it means losing the
      // contract's private state (secretKey, salt, lastHead), which cannot be
      // recovered from the ledger since only commitments are published.
      privateStoragePasswordProvider: () => Promise.resolve(privateStorePassword()),
    }),
    publicDataProvider: indexerPublicDataProvider(CFG.indexer, CFG.indexerWs),
    zkConfigProvider: zkConfig,
    proofProvider: httpClientProofProvider(CFG.proofServer),
    walletProvider: {
      // The *legacy* hex forms, not the bech32m display forms: the protocol
      // encodes these into a bech32 string with a 90-char cap, and the bech32m
      // address is 118 chars — which surfaced as "invalid string length 118".
      coinPublicKey: String(state.shielded.coinPublicKey),
      encryptionPublicKey: String(state.shielded.encryptionPublicKey),
      getCoinPublicKey: () => String(state.shielded.coinPublicKey),
      getEncryptionPublicKey: () => String(state.shielded.encryptionPublicKey),
      // The facade balances into a *recipe*, then finalizes it — there is no
      // single balanceTransaction as the old builder had. `all` so the DUST
      // that pays the fee is balanced alongside the shielded side.
      balanceTx: async (tx: never, ttl?: Date) => {
        const recipe = await wallet.balanceFinalizedTransaction(
          tx,
          { shieldedSecretKeys, dustSecretKey },
          { ttl: ttl ?? new Date(Date.now() + 3_600_000), tokenKindsToBalance: "all" },
        );
        return (await wallet.finalizeRecipe(recipe)) as never;
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

  await wallet.close();
}

main().catch((e) => {
  console.error(`\ndeploy failed: ${e?.message ?? e}`);
  process.exit(1);
});
