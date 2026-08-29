#!/usr/bin/env node
// Copyright (C) 2026 1Claw
// SPDX-License-Identifier: Apache-2.0

/**
 * midnight-signer — HTTP sidecar for Midnight unshielded signing.
 *
 * Exists because the Midnight SDK is TypeScript-only while 1Claw's Vault is
 * Rust. Rather than reimplement derivation and transaction construction, the
 * Vault calls this over loopback. The process boundary is also what keeps this
 * Apache-2.0 code out of the proprietary vault tree.
 *
 * Binds to 127.0.0.1 by default: it holds raw seeds in memory and will sign
 * with them, so it must not be reachable off-host unless deliberately exposed.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { CFG } from "./config.js";
import { closeAll, reap } from "./wallet-pool.js";
import {
  deriveAddress,
  balance,
  dryRun,
  buildAndSign,
  healthz,
  PreconditionError,
  ValidationError,
  type Json,
} from "./routes.js";

const MAX_BODY_BYTES = 64 * 1024;

const ROUTES: Record<string, (body: Json) => Promise<Json> | Json> = {
  "/v1/derive-address": deriveAddress,
  "/v1/balance": balance,
  "/v1/dry-run": dryRun,
  "/v1/build-and-sign": buildAndSign,
};

function send(res: ServerResponse, status: number, payload: Json): void {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function readJson(req: IncomingMessage): Promise<Json> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    // Bounded so a large body cannot be used to exhaust memory in a process
    // that holds signing material.
    if (size > MAX_BODY_BYTES) throw new ValidationError("request body too large");
    chunks.push(c as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Json;
  } catch {
    throw new ValidationError("body must be valid JSON");
  }
}

/**
 * Error text is returned verbatim to the Vault, which surfaces it to the
 * operator — "no DUST" and "no spendable UTXOs" are the whole point. Validation
 * messages are written never to echo a seed.
 */
function errorStatus(e: unknown): number {
  if (e instanceof ValidationError) return 400;
  if (e instanceof PreconditionError) return 409;
  return 502;
}

const server = createServer((req, res) => {
  void (async () => {
    const url = req.url?.split("?")[0] ?? "/";

    if (req.method === "GET" && (url === "/healthz" || url === "/")) {
      return send(res, 200, healthz());
    }

    const handler = ROUTES[url];
    if (!handler) return send(res, 404, { error: `no such route: ${url}` });
    if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });

    try {
      const out = await handler(await readJson(req));
      send(res, 200, out);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      send(res, errorStatus(e), { error: message });
    }
  })();
});

const reaper = setInterval(() => {
  const closed = reap();
  if (closed > 0) console.log(`[midnight-signer] reaped ${closed} idle wallet(s)`);
}, 60_000);
reaper.unref();

async function shutdown(signal: string): Promise<void> {
  console.log(`[midnight-signer] ${signal} — closing wallets`);
  clearInterval(reaper);
  await closeAll();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 5_000).unref();
}
process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

server.listen(CFG.port, CFG.host, () => {
  console.log(`[midnight-signer] listening on http://${CFG.host}:${CFG.port}`);
  console.log(`[midnight-signer] indexer ${CFG.indexer}`);
  console.log(`[midnight-signer] proof server ${CFG.proofServer}`);
});
