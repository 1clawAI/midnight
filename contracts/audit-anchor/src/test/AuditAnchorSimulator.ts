// Copyright (C) 2026 1Claw
// SPDX-License-Identifier: Apache-2.0

import {
  type CircuitContext,
  QueryContext,
  sampleContractAddress,
  createConstructorContext,
  CostModel,
} from "@midnight-ntwrk/compact-runtime";
import {
  Contract,
  type Ledger,
  ledger,
} from "../managed/audit-anchor/contract/index.js";
import {
  type AuditAnchorPrivateState,
  createAuditAnchorPrivateState,
  witnesses,
} from "../witnesses.js";

/**
 * Test harness wrapping the compiled contract, following the pattern used by
 * midnightntwrk/example-bboard.
 *
 * Running the real compiled circuits (rather than a hand-written model of them)
 * is the point: it is what lets the tests assert that the off-chain fold helper
 * agrees with the circuit, instead of two independent implementations that can
 * drift apart silently.
 */
export class AuditAnchorSimulator {
  readonly contract: Contract<AuditAnchorPrivateState>;
  circuitContext: CircuitContext<AuditAnchorPrivateState>;

  constructor(state: AuditAnchorPrivateState) {
    this.contract = new Contract<AuditAnchorPrivateState>(witnesses);
    const { currentPrivateState, currentContractState, currentZswapLocalState } =
      this.contract.initialState(createConstructorContext(state, "0".repeat(64)));
    this.circuitContext = {
      currentPrivateState,
      currentZswapLocalState,
      costModel: CostModel.initialCostModel(),
      currentQueryContext: new QueryContext(
        currentContractState.data,
        sampleContractAddress(),
      ),
    };
  }

  public getLedger(): Ledger {
    return ledger(this.circuitContext.currentQueryContext.state);
  }

  public getPrivateState(): AuditAnchorPrivateState {
    return this.circuitContext.currentPrivateState;
  }

  /** Swap the private state — used to test a different (unauthorised) caller. */
  public as(state: AuditAnchorPrivateState): this {
    this.circuitContext = { ...this.circuitContext, currentPrivateState: state };
    return this;
  }

  public anchorInitial(agentCommitment: Uint8Array): Ledger {
    this.circuitContext = this.contract.impureCircuits.anchorInitial(
      this.circuitContext,
      agentCommitment,
    ).context;
    return this.getLedger();
  }

  public anchorExtend(agentCommitment: Uint8Array): Ledger {
    this.circuitContext = this.contract.impureCircuits.anchorExtend(
      this.circuitContext,
      agentCommitment,
    ).context;
    return this.getLedger();
  }
}
