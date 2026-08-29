// Copyright (C) 2026 1Claw
// SPDX-License-Identifier: Apache-2.0

import {
  type CircuitContext,
  createCircuitContext,
  createConstructorContext,
  sampleContractAddress,
} from "@midnight-ntwrk/compact-runtime";
import {
  Contract,
  type Ledger,
  ledger,
} from "../managed/audit-anchor/contract/index.js";
import {
  type AuditAnchorPrivateState,
  witnesses,
} from "../witnesses.js";

/**
 * Test harness wrapping the compiled contract.
 *
 * Running the real compiled circuits (rather than a model of them) is the point:
 * it is what lets the tests assert that the off-chain fold helper agrees with
 * the circuit instead of two implementations that can drift.
 *
 * On ledger 9 the shape changed in two ways that matter here. `initialState` and
 * the impure circuits are now async, so construction goes through a factory.
 * And `CircuitContext` became a call-tree structure keyed by contract address,
 * built by `createCircuitContext` — so rather than mutating one long-lived
 * context, the simulator keeps the latest contract and private state and builds
 * a fresh context per call, which is also closer to how a real caller works.
 */
export class AuditAnchorSimulator {
  readonly contract: Contract<AuditAnchorPrivateState>;
  readonly address = sampleContractAddress();

  private contractState: unknown;
  private privateState: AuditAnchorPrivateState;
  private zswapLocalState: unknown;

  private constructor(
    contract: Contract<AuditAnchorPrivateState>,
    contractState: unknown,
    privateState: AuditAnchorPrivateState,
    zswapLocalState: unknown,
  ) {
    this.contract = contract;
    this.contractState = contractState;
    this.privateState = privateState;
    this.zswapLocalState = zswapLocalState;
  }

  static async create(state: AuditAnchorPrivateState): Promise<AuditAnchorSimulator> {
    const contract = new Contract<AuditAnchorPrivateState>(witnesses);
    const res = await contract.initialState(
      createConstructorContext(state, "0".repeat(64)),
    );
    return new AuditAnchorSimulator(
      contract,
      res.currentContractState,
      res.currentPrivateState,
      res.currentZswapLocalState,
    );
  }

  private context(circuitId: string): CircuitContext<AuditAnchorPrivateState> {
    return createCircuitContext<AuditAnchorPrivateState>(
      circuitId,
      this.address,
      this.zswapLocalState as never,
      this.contractState as never,
      this.privateState,
    );
  }

  private absorb(result: { context: CircuitContext<AuditAnchorPrivateState> }): Ledger {
    const ctx = result.context;
    this.contractState = ctx.callContext.currentQueryContext.state;
    this.privateState = ctx.callContext.currentPrivateState as AuditAnchorPrivateState;
    this.zswapLocalState = ctx.callContext.currentZswapLocalState;
    return this.getLedger();
  }

  public getLedger(): Ledger {
    return ledger(this.contractState as never);
  }

  public getPrivateState(): AuditAnchorPrivateState {
    return this.privateState;
  }

  /** Swap the private state — used to test a different (unauthorised) caller. */
  public as(state: AuditAnchorPrivateState): this {
    this.privateState = state;
    return this;
  }

  public async anchorInitial(agentCommitment: Uint8Array): Promise<Ledger> {
    return this.absorb(
      await this.contract.impureCircuits.anchorInitial(
        this.context("anchorInitial"),
        agentCommitment,
      ),
    );
  }

  public async anchorExtend(agentCommitment: Uint8Array): Promise<Ledger> {
    return this.absorb(
      await this.contract.impureCircuits.anchorExtend(
        this.context("anchorExtend"),
        agentCommitment,
      ),
    );
  }
}
