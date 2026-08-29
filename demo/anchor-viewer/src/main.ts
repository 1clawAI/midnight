// Copyright (C) 2026 1Claw
// SPDX-License-Identifier: Apache-2.0

import { indexerPublicDataProvider } from "@midnight-ntwrk/midnight-js-indexer-public-data-provider";
import { ledger } from "../../../contracts/audit-anchor/src/managed/audit-anchor/contract/index.js";
import {
  bytes32,
  readLedger,
  verifyAgainstChain,
  expectedCommitment,
  toHex,
  type AnchorRow,
} from "./anchor.js";

type Config = { contractAddress: string; network: string; indexer: string };

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const short = (h: string) => `${h.slice(0, 10)}…${h.slice(-6)}`;

async function loadConfig(): Promise<Config | null> {
  // Written by scripts/deploy-anchor.ts. Absent before the first deploy, which
  // is a normal state rather than an error.
  const res = await fetch("/config.json").catch(() => null);
  if (!res?.ok) return null;
  return (await res.json()) as Config;
}

function renderRows(rows: AnchorRow[]): void {
  const host = $("rows");
  if (rows.length === 0) {
    host.innerHTML = `<p class="dim">Contract deployed, no anchors yet.</p>`;
    return;
  }
  host.innerHTML = `
    <table>
      <thead><tr>
        <th>Agent commitment</th><th>Anchored head</th><th>Epoch</th><th>Owner</th>
      </tr></thead>
      <tbody>
        ${rows
          .map(
            (r) => `<tr>
              <td title="${r.agentCommitment}">${short(r.agentCommitment)}</td>
              <td title="${r.commitment}">${short(r.commitment)}</td>
              <td>${r.epoch.toString()}</td>
              <td title="${r.owner ?? ""}">${r.owner ? short(r.owner) : "—"}</td>
            </tr>`,
          )
          .join("")}
      </tbody>
    </table>
    <p class="dim" style="margin-top:10px">
      Every column is a commitment. None of it discloses an event, the head, or
      which agent this is.
    </p>`;
}

async function refresh(cfg: Config): Promise<void> {
  $("meta").textContent = `${cfg.network} · ${cfg.contractAddress}`;
  try {
    const provider = indexerPublicDataProvider(cfg.indexer, cfg.indexer.replace(/^http/, "ws") + "/ws");
    const state = await provider.queryContractState(cfg.contractAddress);
    if (!state) {
      $("rows").innerHTML = `<p class="bad">No contract state at that address.</p>`;
      return;
    }
    // Decode with the compiled contract's own deserializer. The indexer returns
    // serialized ledger bytes; parsing them by hand would be a second, drifting
    // implementation of the contract's storage layout.
    renderRows(readLedger(ledger(state.data) as never));
  } catch (e) {
    $("rows").innerHTML = `<p class="bad">${e instanceof Error ? e.message : String(e)}</p>`;
  }
}

function wireVerify(): void {
  $("verify").addEventListener("click", () => {
    const out = $("result");
    try {
      const head = bytes32($<HTMLInputElement>("head").value || "00");
      const events = $<HTMLTextAreaElement>("events")
        .value.split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map(bytes32);
      const claim = $<HTMLInputElement>("claim").value.trim();

      const computed = toHex(expectedCommitment(head, events));
      if (!claim) {
        out.className = "result";
        out.textContent = `commitment = ${computed}`;
        return;
      }
      const { ok } = verifyAgainstChain(claim, head, events);
      out.className = ok ? "result ok" : "result bad";
      out.textContent = ok
        ? `✓ matches — these ${events.length} event(s) extend that head to the anchored commitment`
        : `✗ does not match\n  computed ${computed}\n  claimed  ${claim.toLowerCase()}`;
    } catch (e) {
      out.className = "result bad";
      out.textContent = e instanceof Error ? e.message : String(e);
    }
  });
}

async function main(): Promise<void> {
  wireVerify();
  const cfg = await loadConfig();
  if (!cfg?.contractAddress) {
    $("meta").textContent = "not deployed yet";
    $("rows").innerHTML =
      `<p class="dim">No config.json — run <code>npm run deploy:anchor</code> first. ` +
      `Offline verification below works regardless.</p>`;
    return;
  }
  await refresh(cfg);
}

void main();
