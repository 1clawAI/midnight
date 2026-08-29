import { defineConfig } from "vite";
import wasm from "vite-plugin-wasm";
import { fileURLToPath } from "node:url";

export default defineConfig({
  // The compiled Compact contract loads @midnight-ntwrk/onchain-runtime-v3,
  // which is WASM — Vite has no native ESM-integration support for it. Without
  // this the ledger() deserializer cannot run in a browser, and the viewer
  // would have to parse indexer bytes by hand: a second implementation of the
  // contract's storage layout, free to drift from the circuit.
  //
  // Top-level await needs no plugin here; `esnext` supports it natively, and
  // vite-plugin-top-level-await's swc pass fails on this dependency graph.
  plugins: [wasm()],
  resolve: {
    alias: {
      // isomorphic-ws' browser build has no named WebSocket export, which the
      // indexer provider imports. Browsers ship WebSocket, so alias rather than
      // polyfill.
      "isomorphic-ws": fileURLToPath(new URL("./src/shims/isomorphic-ws.ts", import.meta.url)),
    },
  },
  optimizeDeps: { exclude: ["@midnight-ntwrk/compact-runtime"] },
  build: { target: "esnext" },
});
