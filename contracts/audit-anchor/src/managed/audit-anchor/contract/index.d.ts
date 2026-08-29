import type * as __compactRuntime from '@midnight-ntwrk/compact-runtime';

export type Witnesses<PS> = {
  localSecretKey(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
  localPrevHead(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array];
  localEventCount(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, bigint];
  localNewEventHashes(context: __compactRuntime.WitnessContext<Ledger, PS>): [PS, Uint8Array[]];
}

export type ImpureCircuits<PS> = {
  anchorInitial(context: __compactRuntime.CircuitContext<PS>,
                agentCommitment_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  anchorExtend(context: __compactRuntime.CircuitContext<PS>,
               agentCommitment_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
}

export type ProvableCircuits<PS> = {
  anchorInitial(context: __compactRuntime.CircuitContext<PS>,
                agentCommitment_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  anchorExtend(context: __compactRuntime.CircuitContext<PS>,
               agentCommitment_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
}

export type PureCircuits = {
  maxEvents(): bigint;
  ownerTag(sk_0: Uint8Array): Uint8Array;
  headTag(head_0: Uint8Array): Uint8Array;
  foldStep(head_0: Uint8Array, eventHash_0: Uint8Array): Uint8Array;
}

export type Circuits<PS> = {
  maxEvents(context: __compactRuntime.CircuitContext<PS>): __compactRuntime.CircuitResults<PS, bigint>;
  ownerTag(context: __compactRuntime.CircuitContext<PS>, sk_0: Uint8Array): __compactRuntime.CircuitResults<PS, Uint8Array>;
  headTag(context: __compactRuntime.CircuitContext<PS>, head_0: Uint8Array): __compactRuntime.CircuitResults<PS, Uint8Array>;
  foldStep(context: __compactRuntime.CircuitContext<PS>,
           head_0: Uint8Array,
           eventHash_0: Uint8Array): __compactRuntime.CircuitResults<PS, Uint8Array>;
  anchorInitial(context: __compactRuntime.CircuitContext<PS>,
                agentCommitment_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
  anchorExtend(context: __compactRuntime.CircuitContext<PS>,
               agentCommitment_0: Uint8Array): __compactRuntime.CircuitResults<PS, []>;
}

export type Ledger = {
  commitments: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): Uint8Array;
    [Symbol.iterator](): Iterator<[Uint8Array, Uint8Array]>
  };
  epochs: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): bigint;
    [Symbol.iterator](): Iterator<[Uint8Array, bigint]>
  };
  owners: {
    isEmpty(): boolean;
    size(): bigint;
    member(key_0: Uint8Array): boolean;
    lookup(key_0: Uint8Array): Uint8Array;
    [Symbol.iterator](): Iterator<[Uint8Array, Uint8Array]>
  };
}

export type ContractReferenceLocations = any;

export declare const contractReferenceLocations : ContractReferenceLocations;

export declare class Contract<PS = any, W extends Witnesses<PS> = Witnesses<PS>> {
  witnesses: W;
  circuits: Circuits<PS>;
  impureCircuits: ImpureCircuits<PS>;
  provableCircuits: ProvableCircuits<PS>;
  constructor(witnesses: W);
  initialState(context: __compactRuntime.ConstructorContext<PS>): __compactRuntime.ConstructorResult<PS>;
}

export declare function ledger(state: __compactRuntime.StateValue | __compactRuntime.ChargedState): Ledger;
export declare const pureCircuits: PureCircuits;
