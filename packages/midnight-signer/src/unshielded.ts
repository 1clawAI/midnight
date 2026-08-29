// Copyright (C) 2026 1Claw
// SPDX-License-Identifier: Apache-2.0

/**
 * Unshielded NIGHT balance, read from the indexer.
 *
 * The wallet SDK cannot answer this. `WalletState.balances` covers Zswap
 * *shielded* coins only, so a wallet holding faucet NIGHT reports zero — which
 * is what made /v1/balance and /v1/dry-run insist a funded wallet was empty.
 *
 * The indexer exposes no unspent-output query either; the only way in is the
 * `unshieldedTransactions(address)` **subscription**, so a balance is computed
 * by replaying that address's history and netting created against spent.
 */

import { createClient, type Client } from "graphql-ws";
import WebSocket from "ws";
import { CFG } from "./config.js";

const SUBSCRIPTION = `
subscription($address: UnshieldedAddress!) {
  unshieldedTransactions(address: $address) {
    __typename
    ... on UnshieldedTransaction {
      transaction {
        hash
        unshieldedCreatedOutputs { owner value tokenType }
        unshieldedSpentOutputs { owner value tokenType }
      }
    }
    ... on UnshieldedTransactionsProgress { highestTransactionId }
  }
}`;

/** Native NIGHT is the all-zero token type. */
const NATIVE = /^0+$/;

export type UnshieldedBalance = {
  /** Net NIGHT in base units (6 decimals). */
  nightBaseUnits: string;
  /** Transactions replayed to reach it — useful when a total looks wrong. */
  transactions: number;
  /** True if the replay ended on a progress marker rather than a timeout. */
  complete: boolean;
};

function wsUrl(): string {
  return CFG.indexer.replace(/^http/, "ws").replace(/\/graphql$/, "/graphql/ws");
}

/**
 * Replay an address's unshielded history and net the outputs.
 *
 * `quietMs` ends the replay once the stream stops producing: the subscription
 * stays open for live updates after catching up, so there is no natural
 * completion event to wait for. `timeoutMs` bounds the whole thing so a stalled
 * indexer surfaces as a slow answer rather than a hung request.
 */
export async function unshieldedNight(
  address: string,
  { timeoutMs = 30_000, quietMs = 2_500 }: { timeoutMs?: number; quietMs?: number } = {},
): Promise<UnshieldedBalance> {
  const client: Client = createClient({
    url: wsUrl(),
    webSocketImpl: WebSocket,
    retryAttempts: 0,
  });

  let created = 0n;
  let spent = 0n;
  let transactions = 0;
  let sawProgress = false;

  try {
    await new Promise<void>((resolve, reject) => {
      let quiet: NodeJS.Timeout;
      const hard = setTimeout(() => finish(), timeoutMs);
      const bump = () => {
        clearTimeout(quiet);
        quiet = setTimeout(() => finish(), quietMs);
      };
      let done = false;
      const finish = (err?: unknown) => {
        if (done) return;
        done = true;
        clearTimeout(hard);
        clearTimeout(quiet);
        dispose();
        err ? reject(err) : resolve();
      };

      const dispose = client.subscribe(
        { query: SUBSCRIPTION, variables: { address } },
        {
          next: (msg) => {
            bump();
            const payload = (msg.data as Record<string, never> | undefined)?.[
              "unshieldedTransactions"
            ] as
              | {
                  __typename?: string;
                  transaction?: {
                    unshieldedCreatedOutputs?: { owner: string; value: string; tokenType: string }[];
                    unshieldedSpentOutputs?: { owner: string; value: string; tokenType: string }[];
                  };
                }
              | undefined;
            if (!payload) return;
            if (payload.__typename === "UnshieldedTransactionsProgress") {
              sawProgress = true;
              return;
            }
            const tx = payload.transaction;
            if (!tx) return;
            transactions++;
            // Filter by owner: a transaction reaches this subscription because
            // it touches the address, but it can carry outputs to others too
            // (the faucet's own change, for one).
            for (const o of tx.unshieldedCreatedOutputs ?? []) {
              if (o.owner === address && NATIVE.test(o.tokenType)) created += BigInt(o.value);
            }
            for (const o of tx.unshieldedSpentOutputs ?? []) {
              if (o.owner === address && NATIVE.test(o.tokenType)) spent += BigInt(o.value);
            }
          },
          error: (e) => finish(e),
          complete: () => finish(),
        },
      );
      bump();
    });
  } finally {
    await Promise.resolve(client.dispose()).catch(() => {});
  }

  const net = created - spent;
  return {
    nightBaseUnits: (net < 0n ? 0n : net).toString(),
    transactions,
    complete: sawProgress,
  };
}
