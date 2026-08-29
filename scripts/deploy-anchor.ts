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
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WalletBuilder } from "@midnight-ntwrk/wallet";
import { NetworkId, nativeToken } from "@midnight-ntwrk/zswap";
import { deployContract } from "@midnight-ntwrk/midnight-js-contracts";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONTRACT_DIR = resolve(ROOT, "contracts/audit-anchor");
const MANAGED = resolve(CONTRACT_DIR, "src/managed/audit-anchor");
const VIEWER_CONFIG = resolve(ROOT, "demo/anchor-viewer/config.json");

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

  if (coins.length === 0) {
    // Deployment both proves a circuit and pays a fee, so it needs NIGHT and
    // accrued DUST. Failing here with the reason beats a confusing SDK error.
    throw new Error(
      "deployer has no spendable coins — fund it from the Preprod faucet and wait for DUST to accrue",
    );
  }

  const { Contract, ledger } = (await import(
    resolve(MANAGED, "contract/index.js")
  )) as { Contract: new (w: unknown) => unknown; ledger: unknown };
  const { witnesses, createAuditAnchorPrivateState } = (await import(
    resolve(CONTRACT_DIR, "src/witnesses.ts")
  )) as typeof import("../contracts/audit-anchor/src/witnesses.js");

  const providers = {
    privateStateProvider: levelPrivateStateProvider({ privateStateStoreName: "audit-anchor" }),
    publicDataProvider: indexerPublicDataProvider(CFG.indexer, CFG.indexerWs),
    zkConfigProvider: new NodeZkConfigProvider(MANAGED),
    proofProvider: httpClientProofProvider(CFG.proofServer),
    walletProvider: {
      coinPublicKey: state.coinPublicKey as string,
      encryptionPublicKey: state.encryptionPublicKey as string,
      getCoinPublicKey: () => state.coinPublicKey as string,
      getEncryptionPublicKey: () => state.encryptionPublicKey as string,
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
    contract: new Contract(witnesses) as never,
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
  void ledger;
}

main().catch((e) => {
  console.error(`\ndeploy failed: ${e?.message ?? e}`);
  process.exit(1);
});
