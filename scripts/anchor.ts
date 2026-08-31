/**
 * Anchor a 1Claw audit-chain head to the deployed AuditAnchor contract.
 *
 * Deploying the contract published an empty ledger. This is the script that
 * actually uses it: it registers an agent on first run (`anchorInitial`) and
 * folds new audit events into the anchored commitment on every run after
 * (`anchorExtend`). Until this existed the viewer had nothing to show, because
 * nothing had ever been anchored.
 *
 * Requires the proof server (docker, :6300) and a wallet holding DUST — an
 * anchor is a proved, fee-paying transaction like any other.
 *
 *   npx tsx scripts/anchor.ts --agent demo-agent
 *   npx tsx scripts/anchor.ts --agent demo-agent --events 3
 *   npx tsx scripts/anchor.ts --agent demo-agent --event <64-hex> --event <64-hex>
 */
import { randomBytes, createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { HDWallet, Roles, createKeystore } from "@midnightntwrk/wallet-sdk";
import * as ledger from "@midnight-ntwrk/midnight-js-protocol/ledger";
import { findDeployedContract } from "@midnight-ntwrk/midnight-js-contracts";
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

const VIEWER_CONFIG = resolve(ROOT, "demo/anchor-viewer/public/config.json");

/** Domain separator, so an agent commitment cannot collide with a head or owner tag. */
const AGENT_DOMAIN = Buffer.from("1claw:anchor:agent".padEnd(32, "\0"), "utf8");

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function args(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => {
    if (a === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]);
  });
  return out;
}

function bytes32(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  if (!/^[0-9a-fA-F]{64}$/.test(clean)) {
    throw new Error(`expected 32 bytes of hex, got "${hex}"`);
  }
  return Uint8Array.from(Buffer.from(clean, "hex"));
}

const toHex = (b: Uint8Array): string => Buffer.from(b).toString("hex");

function contractAddress(): string {
  const explicit = arg("address") ?? E.MIDNIGHT_ANCHOR_ADDRESS;
  if (explicit) return explicit;
  const cfg = JSON.parse(readFileSync(VIEWER_CONFIG, "utf8")) as { contractAddress?: string };
  if (!cfg.contractAddress) {
    throw new Error(`no contract address in ${VIEWER_CONFIG} — deploy first, or pass --address`);
  }
  return cfg.contractAddress;
}

async function main(): Promise<void> {
  await preflight();
  setNetworkId("preprod");

  const agentId = arg("agent") ?? "demo-agent";
  const address = contractAddress();

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

  console.log(`Anchoring to ${address}`);
  console.log("  syncing …");
  const { wallet, state } = await syncWithRestarts({
    shieldedSecretKeys,
    dustSecretKey,
    unshieldedKeystore,
  });

  const dust = state.dust.balance(new Date());
  console.log(`  DUST: ${dust}`);
  if (dust === 0n) {
    throw new Error("no DUST — fees cannot be paid; run scripts/register-dust.ts");
  }

  const compiled = (await import(resolve(MANAGED, "contract/index.js"))) as {
    Contract: unknown;
    pureCircuits: {
      foldStep(head: Uint8Array, eventHash: Uint8Array): Uint8Array;
      headTag(head: Uint8Array): Uint8Array;
    };
  };
  const { witnesses, createAuditAnchorPrivateState } = (await import(
    resolve(CONTRACT_DIR, "src/witnesses.ts")
  )) as typeof import("../contracts/audit-anchor/src/witnesses.js");

  const compiledContract = CompiledContract.make("AuditAnchor", compiled.Contract as never).pipe(
    CompiledContract.withWitnesses(witnesses as never),
    CompiledContract.withCompiledFileAssets(MANAGED),
  );

  const zkConfig = new NodeZkConfigProvider(MANAGED);
  const providers = {
    privateStateProvider: levelPrivateStateProvider({
      privateStateStoreName: "audit-anchor",
      accountId: state.shielded.address.coinPublicKeyString(),
      privateStoragePasswordProvider: () => Promise.resolve(privateStorePassword()),
    }),
    publicDataProvider: indexerPublicDataProvider(CFG.indexer, CFG.indexerWs),
    zkConfigProvider: zkConfig,
    proofProvider: httpClientProofProvider(CFG.proofServer, zkConfig),
    walletProvider: {
      coinPublicKey: state.shielded.coinPublicKey.toHexString(),
      encryptionPublicKey: state.shielded.encryptionPublicKey.toHexString(),
      getCoinPublicKey: () => state.shielded.coinPublicKey.toHexString(),
      getEncryptionPublicKey: () => state.shielded.encryptionPublicKey.toHexString(),
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

  // The private state carries the anchor secretKey and salt written at deploy.
  // Reusing it is the whole point: `anchorExtend` checks ownerTag(sk) against
  // the registered owner, so a fresh secret could never extend this agent.
  const store = (
    providers as unknown as {
      privateStateProvider: {
        setContractAddress(a: string): void;
        get(id: string): Promise<unknown | null>;
        set(id: string, s: unknown): Promise<void>;
      };
    }
  ).privateStateProvider;
  // Required before any get/set: the provider namespaces private state per
  // contract, and `get` throws without it. Not calling it first — and catching
  // the throw — turned a clear "call setContractAddress" into a wrong claim
  // that the deploy's private state was missing.
  store.setContractAddress(address);
  const existing = (await store.get("audit-anchor")) as
    | { secretKey: Uint8Array; registrationSalt: Uint8Array; lastHead: Uint8Array }
    | null;
  if (!existing?.secretKey) {
    throw new Error(
      "no anchor private state for this wallet — deploy wrote it, so either the store " +
        "password changed or this is a different wallet than the one that deployed",
    );
  }

  // agentCommitment = H(H(domain, agentId), salt), built from the contract's own
  // compiled `foldStep` rather than a second hand-written persistentHash
  // encoding — the encodings would drift, and the contract is the definition.
  const agentIdBytes = createHash("sha256").update(agentId, "utf8").digest();
  const agentCommitment = compiled.pureCircuits.foldStep(
    compiled.pureCircuits.foldStep(
      Uint8Array.from(AGENT_DOMAIN),
      Uint8Array.from(agentIdBytes),
    ),
    existing.registrationSalt,
  );
  console.log(`  agent "${agentId}" -> commitment ${toHex(agentCommitment).slice(0, 16)}…`);

  const found = await findDeployedContract(providers, {
    contractAddress: address,
    compiledContract,
    privateStateId: "audit-anchor",
  } as never);

  // Registered already? Then this is an extension, and it needs events to fold.
  const publicState = await (
    providers as unknown as {
      publicDataProvider: { queryContractState(a: string): Promise<{ data: unknown } | null> };
    }
  ).publicDataProvider.queryContractState(address);
  const { ledger: readLedgerState } = compiled as unknown as {
    ledger(data: unknown): { epochs: { member(k: Uint8Array): boolean } };
  };
  const registered = publicState
    ? readLedgerState(publicState.data).epochs.member(agentCommitment)
    : false;

  const call = found as unknown as {
    callTx: {
      anchorInitial(c: Uint8Array): Promise<{ public: { txId: string; blockHeight?: number } }>;
      anchorExtend(c: Uint8Array): Promise<{ public: { txId: string; blockHeight?: number } }>;
    };
  };

  if (!registered) {
    console.log("  not registered yet — anchorInitial (proving, ~30s) …");
    const res = await call.callTx.anchorInitial(agentCommitment);
    console.log(`\n  registered. tx ${res.public.txId}`);
    console.log("  epoch 1. Run again with --events to fold audit events in.");
  } else {
    const explicit = args("event").map(bytes32);
    const count = Number(arg("events") ?? (explicit.length ? explicit.length : 3));
    const events = explicit.length
      ? explicit
      : Array.from({ length: count }, () => Uint8Array.from(randomBytes(32)));
    if (events.length < 1 || events.length > 8) {
      throw new Error(`anchor folds 1..8 events per call, got ${events.length}`);
    }

    // The witnesses read pendingEvents and lastHead from private state, so the
    // events are staged there rather than passed to the circuit directly —
    // that is what keeps them off the ledger.
    await store.set(
      "audit-anchor",
      createAuditAnchorPrivateState(
        existing.secretKey,
        existing.registrationSalt,
        existing.lastHead,
        events,
      ),
    );

    console.log(`  folding ${events.length} event(s) — anchorExtend (proving, ~30s) …`);
    const res = await call.callTx.anchorExtend(agentCommitment);
    console.log(`\n  anchored. tx ${res.public.txId}`);

    // Advance the local head to what the circuit folded, and clear the batch.
    // Getting this wrong is unrecoverable in the sense that matters: the next
    // anchorExtend asserts headTag(prevHead) == the anchored commitment, so a
    // stale head here means every future anchor for this agent fails.
    const newHead = events.reduce(
      (h, e) => compiled.pureCircuits.foldStep(h, e),
      existing.lastHead,
    );
    await store.set(
      "audit-anchor",
      createAuditAnchorPrivateState(existing.secretKey, existing.registrationSalt, newHead, []),
    );
    console.log(`  local head advanced to ${toHex(newHead).slice(0, 16)}…`);
  }

  console.log(`\n  viewer: https://1claw-anchor-viewer.vercel.app`);
  await wallet.stop();
}

main().catch((e) => {
  console.error(`\nanchor failed: ${e?.message ?? e}`);
  if (e?.stack) console.error(`\n${e.stack}`);
  process.exit(1);
});
