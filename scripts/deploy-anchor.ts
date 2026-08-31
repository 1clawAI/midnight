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
import { dirname, resolve } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";
import {
  HDWallet,
  Roles,
  createKeystore,
} from "@midnightntwrk/wallet-sdk";
import * as ledger from "@midnight-ntwrk/midnight-js-protocol/ledger";
import { deployContract } from "@midnight-ntwrk/midnight-js-contracts";
import { CompiledContract } from "@midnight-ntwrk/midnight-js-protocol/compact-js";
import { setNetworkId, getNetworkId } from "@midnight-ntwrk/midnight-js-network-id";
import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { httpClientProofProvider } from "@midnight-ntwrk/midnight-js-http-client-proof-provider";
import { levelPrivateStateProvider } from "@midnight-ntwrk/midnight-js-level-private-state-provider";
import { NodeZkConfigProvider } from "@midnight-ntwrk/midnight-js-node-zk-config-provider";
import {
  CONTRACT_DIR,
  E,
  MANAGED,
  ROOT,
  CFG,
  preflight,
  privateStorePassword,
  syncWithRestarts,
} from "./lib/anchor-runtime.js";

// public/, not the app root: Vite serves and copies only publicDir, so a
// config written beside package.json 404s in dev and never reaches dist.
const VIEWER_CONFIG = resolve(ROOT, "demo/anchor-viewer/public/config.json");

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
