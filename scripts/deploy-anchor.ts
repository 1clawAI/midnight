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
import { WalletBuilder } from "@midnight-ntwrk/wallet";
import { NetworkId, nativeToken } from "@midnight-ntwrk/zswap";
import { deployContract } from "@midnight-ntwrk/midnight-js-contracts";
import { CompiledContract } from "@midnight-ntwrk/midnight-js-protocol/compact-js";
import { setNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
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
  // midnight-js keeps the network id in module state and refuses any wallet or
  // contract operation until it is set. Preprod runs under the TestNet id.
  setNetworkId("test");
  console.log("Deploying AuditAnchor to Preprod");

  const wallet = await WalletBuilder.build(
    CFG.indexer,
    CFG.indexerWs,
    CFG.proofServer,
    CFG.node,
    E.MIDNIGHT_DEPLOYER_SEED,
    NetworkId.TestNet,
    "warn",
  );
  wallet.start();

  const state = await new Promise<Record<string, unknown>>((done) => {
    const sub = wallet.state().subscribe((s: unknown) => {
      sub.unsubscribe();
      done(s as Record<string, unknown>);
    });
  });

  const coins = (state.availableCoins as unknown[] | undefined) ?? [];
  const balances = (state.balances ?? {}) as Record<string, unknown>;
  console.log(`  deployer: ${state.address as string}`);
  console.log(`  coins: ${coins.length} | balances: ${JSON.stringify(balances)}`);

  // Checking `availableCoins` here was wrong: that is the Zswap *shielded* set,
  // and faucet NIGHT arrives unshielded, so a funded wallet failed this test.
  // The unshielded balance is the meaningful precondition; whether DUST has
  // accrued is left to the SDK, which is the only thing that actually knows.
  const unshielded = unshieldedAddressForSeed(E.MIDNIGHT_DEPLOYER_SEED);
  console.log(`  unshielded: ${unshielded}`);
  if (coins.length === 0) {
    console.log("  note: no shielded coins; relying on unshielded NIGHT + DUST");
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
      accountId: state.address as string,
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
      coinPublicKey: state.coinPublicKeyLegacy as string,
      encryptionPublicKey: state.encryptionPublicKeyLegacy as string,
      getCoinPublicKey: () => state.coinPublicKeyLegacy as string,
      getEncryptionPublicKey: () => state.encryptionPublicKeyLegacy as string,
      balanceTx: (tx: never, ttl?: Date) =>
        wallet.balanceTransaction(tx, []).then((r: never) => r) as never,
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
  void nativeToken;
}

main().catch((e) => {
  console.error(`\ndeploy failed: ${e?.message ?? e}`);
  process.exit(1);
});
