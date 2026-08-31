// Copyright (C) 2026 1Claw
// SPDX-License-Identifier: Apache-2.0

/** Preprod endpoints. Overridable, but these are the published defaults. */
export const CFG = {
  indexer: envOr("MIDNIGHT_INDEXER_URL", "https://indexer.preprod.midnight.network/api/v4/graphql"),
  indexerWs: envOr(
    "MIDNIGHT_INDEXER_WS_URL",
    "wss://indexer.preprod.midnight.network/api/v4/graphql/ws",
  ),
  node: envOr("MIDNIGHT_NODE_URL", "https://rpc.preprod.midnight.network"),
  proofServer: envOr("MIDNIGHT_PROOF_SERVER_URL", "http://127.0.0.1:6300"),
  port: Number(envOr("MIDNIGHT_SIGNER_PORT", "8091")),
  /**
   * Loopback by default. This process holds raw seeds in memory and exposes an
   * endpoint that signs with them; it must not be reachable off-host unless the
   * operator makes that choice explicitly.
   */
  host: envOr("MIDNIGHT_SIGNER_HOST", "127.0.0.1"),
  /**
   * How long a built wallet is kept warm. Building and connecting takes seconds,
   * so a per-request wallet would make signing unusable — but seeds should not
   * linger in memory indefinitely either.
   */
  walletTtlMs: Number(envOr("MIDNIGHT_SIGNER_WALLET_TTL_MS", String(30 * 60 * 1000))),
  /**
   * Where sync checkpoints live, one file per wallet.
   *
   * A cold Preprod sync is roughly 80 minutes, so without a checkpoint on disk
   * a restarted signer reports zero DUST and cannot pay a fee until it finishes
   * catching up. Defaults alongside the deploy script's own checkpoint.
   */
  checkpointDir: envOr("MIDNIGHT_SIGNER_CHECKPOINT_DIR", "../../.sync-checkpoints"),
  /** The dust blob is ~11MB, so this trades write cost against resync cost. */
  checkpointEveryMs: Number(envOr("MIDNIGHT_SIGNER_CHECKPOINT_MS", String(60 * 1000))),
} as const;

function envOr(key: string, fallback: string): string {
  const v = process.env[key];
  return v && v.trim() ? v.trim() : fallback;
}

/** NIGHT has 6 decimals. */
export const NIGHT_DECIMALS = 6;
