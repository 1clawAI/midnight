// Copyright (C) 2026 1Claw
// SPDX-License-Identifier: Apache-2.0

/**
 * Report whether each wallet's NIGHT is registered for DUST generation.
 *
 * DUST pays fees and does not appear merely because a wallet holds NIGHT: each
 * unshielded UTXO carries a `registeredForDustGeneration` flag, and the faucet
 * hands out NIGHT with it false. Registration is backed by a *Cardano* UTXO —
 * the indexer's DustRegistration type keys on `utxoTxHash` / `utxoOutputIndex`
 * described as Cardano fields, and `dustGenerationStatus` rejects a Midnight
 * address outright.
 *
 * This only reports; scripts/register-dust.ts does the registering. It answers
 * the one question worth asking before waiting on DUST: is this NIGHT actually
 * generating?
 *
 *   npx tsx scripts/check-dust-registration.ts
 */
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createClient } from "graphql-ws";
import WebSocket from "ws";
import { unshieldedAddressForSeed } from "./unshielded-address.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WS = process.env.MIDNIGHT_INDEXER_WS_URL
  ?? "wss://indexer.preprod.midnight.network/api/v4/graphql/ws";

const QUERY = `subscription($address: UnshieldedAddress!) {
  unshieldedTransactions(address: $address) {
    ... on UnshieldedTransaction {
      transaction { unshieldedCreatedOutputs { owner value tokenType registeredForDustGeneration } }
    }
    ... on UnshieldedTransactionsProgress { highestTransactionId }
  }
}`;

type Utxo = { value: string; registered: boolean };

async function utxosFor(address: string): Promise<Utxo[]> {
  const client = createClient({ url: WS, webSocketImpl: WebSocket as never, retryAttempts: 0 });
  const found: Utxo[] = [];
  await new Promise<void>((done) => {
    // Two timers: a hard cap, and a quiet period that ends the stream once the
    // indexer stops sending. Without the quiet timer this always waits the cap.
    const hard = setTimeout(finish, 30_000);
    let quiet: NodeJS.Timeout;
    let closed = false;
    function finish() {
      if (closed) return;
      closed = true;
      clearTimeout(hard); clearTimeout(quiet); dispose(); done();
    }
    const dispose = client.subscribe({ query: QUERY, variables: { address } }, {
      next: (m: never) => {
        clearTimeout(quiet);
        quiet = setTimeout(finish, 3_000);
        const tx = (m as { data?: { unshieldedTransactions?: { transaction?: {
          unshieldedCreatedOutputs?: { owner: string; value: string; registeredForDustGeneration: boolean }[] } } } })
          .data?.unshieldedTransactions?.transaction;
        for (const o of tx?.unshieldedCreatedOutputs ?? []) {
          if (o.owner === address) found.push({ value: o.value, registered: o.registeredForDustGeneration });
        }
      },
      error: finish,
      complete: finish,
    });
  });
  return found;
}

const env = Object.fromEntries(
  readFileSync(resolve(ROOT, ".env.local"), "utf8")
    .split("\n").filter((l) => l.includes("=") && !l.startsWith("#"))
    .map((l) => { const i = l.indexOf("="); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^"|"$/g, "")]; }),
);

let anyUnregistered = false;
for (const [key, label] of [["MIDNIGHT_DEPLOYER_SEED", "deployer"], ["MIDNIGHT_AGENT_SEED", "agent"]] as const) {
  if (!env[key]) { console.log(`${label}: no seed in .env.local`); continue; }
  const address = unshieldedAddressForSeed(env[key]);
  const utxos = await utxosFor(address);
  const night = utxos.reduce((a, u) => a + BigInt(u.value), 0n);
  const registered = utxos.filter((u) => u.registered).length;

  console.log(`\n${label}`);
  console.log(`  ${address}`);
  console.log(`  NIGHT     ${(Number(night) / 1e6).toLocaleString()}`);
  console.log(`  UTXOs     ${utxos.length}  (${registered} registered for DUST generation)`);
  if (utxos.length && registered === 0) {
    anyUnregistered = true;
    console.log(`  STATUS    not generating DUST — this wallet cannot pay a fee`);
  } else if (registered > 0) {
    console.log(`  STATUS    generating`);
  } else {
    console.log(`  STATUS    no NIGHT — fund it first`);
  }
}

if (anyUnregistered) {
  console.log(`\nNIGHT held but unregistered. Fix it with:`);
  console.log(`  npx tsx scripts/register-dust.ts            # deployer`);
  console.log(`  npx tsx scripts/register-dust.ts agent      # agent`);
  console.log(`Needs the proof server on :6300 — registration is a proved transaction.`);
  process.exit(2);
}
process.exit(0);
