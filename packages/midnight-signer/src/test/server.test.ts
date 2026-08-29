import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Server } from "node:http";

/**
 * Exercises the real HTTP surface. Anything needing a funded wallet is out of
 * scope here — what is asserted is the contract the Vault's Rust client depends
 * on: route shape, status codes, and that a bad request is rejected before any
 * wallet is built.
 */
let server: Server;
let base: string;

beforeAll(async () => {
  process.env.MIDNIGHT_SIGNER_PORT = "0"; // ephemeral
  process.env.MIDNIGHT_SIGNER_HOST = "127.0.0.1";
  const { createServer } = await import("node:http");
  const routes = await import("../routes.js");

  server = createServer((req, res) => {
    void (async () => {
      const url = req.url?.split("?")[0] ?? "/";
      const send = (s: number, p: unknown) => {
        const b = JSON.stringify(p);
        res.writeHead(s, { "content-type": "application/json" });
        res.end(b);
      };
      if (req.method === "GET" && url === "/healthz") return send(200, routes.healthz());

      const map: Record<string, (b: never) => unknown> = {
        "/v1/derive-address": routes.deriveAddress as never,
        "/v1/balance": routes.balance as never,
        "/v1/dry-run": routes.dryRun as never,
        "/v1/build-and-sign": routes.buildAndSign as never,
      };
      const h = map[url];
      if (!h) return send(404, { error: `no such route: ${url}` });
      if (req.method !== "POST") return send(405, { error: "method not allowed" });

      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body: unknown = {};
      try {
        body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      } catch {
        return send(400, { error: "body must be valid JSON" });
      }
      try {
        send(200, await (h as (b: unknown) => Promise<unknown>)(body));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const status = e instanceof routes.ValidationError ? 400 : 502;
        send(status, { error: msg });
      }
    })();
  });

  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const post = (path: string, body: unknown) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const SEED = "a".repeat(64);
const ADDR = "mn_shield-addr_test1tdc03xvkcr26w2zt4pghkn4h2y4f8lcld8ujncy9tuszmu52nemsxq";

describe("midnight-signer HTTP surface", () => {
  it("healthz reports the network it will serve", async () => {
    const r = await fetch(`${base}/healthz`);
    expect(r.status).toBe(200);
    const j = (await r.json()) as Record<string, unknown>;
    expect(j.ok).toBe(true);
    expect(j.network).toBe("preprod");
  });

  it("404s an unknown route and 405s a GET on a POST route", async () => {
    expect((await fetch(`${base}/v1/nope`, { method: "POST" })).status).toBe(404);
    expect((await fetch(`${base}/v1/balance`)).status).toBe(405);
  });

  it("rejects mainnet before touching a wallet", async () => {
    // The important one: no route may reach the network on mainnet.
    for (const path of ["/v1/derive-address", "/v1/balance", "/v1/dry-run", "/v1/build-and-sign"]) {
      const r = await post(path, {
        seed_hex: SEED,
        network: "midnight-mainnet",
        to_address: ADDR,
        amount_base_units: "1",
      });
      expect(r.status, path).toBe(400);
      expect(((await r.json()) as { error: string }).error).toMatch(/mainnet is not supported/);
    }
  });

  it("rejects a malformed seed without echoing it", async () => {
    const r = await post("/v1/derive-address", { seed_hex: "deadbeef", network: "preprod" });
    expect(r.status).toBe(400);
    const { error } = (await r.json()) as { error: string };
    expect(error).toMatch(/64 hex/);
    expect(error).not.toContain("deadbeef");
  });

  it("rejects a non-Midnight destination before proving", async () => {
    const r = await post("/v1/build-and-sign", {
      seed_hex: SEED,
      network: "preprod",
      to_address: "0x0000000000000000000000000000000000000000",
      amount_base_units: "1000",
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/not a Midnight address/);
  });

  it("rejects zero and fractional amounts", async () => {
    for (const amount of ["0", "1.5", "-5"]) {
      const r = await post("/v1/build-and-sign", {
        seed_hex: SEED,
        network: "preprod",
        to_address: ADDR,
        amount_base_units: amount,
      });
      expect(r.status, amount).toBe(400);
    }
  });

  it("rejects invalid JSON", async () => {
    const r = await fetch(`${base}/v1/balance`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(r.status).toBe(400);
  });
});
