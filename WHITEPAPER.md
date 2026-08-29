<!--
Copyright (C) 2026 1Claw
SPDX-License-Identifier: Apache-2.0
-->

# Anchoring a private audit log to a public ledger

**AuditAnchor — a Compact contract for 1Claw × Midnight**

---

## 1. The problem

1Claw keeps an audit log for every organization. Each entry records who did
what: the acting principal, the action, its metadata, and a timestamp. Entries
are chained — each one is an HMAC-SHA256 over its own contents together with the
hash of the entry before it, so altering any historical entry invalidates every
hash after it.

That construction is genuinely useful and it has a precise limit:

> A hash chain proves the log has not been altered **to whoever holds the log.**

1Claw holds the log. 1Claw also holds the HMAC key. A tamper-evident chain
detects an outsider editing the database; it does not constrain the party who
can recompute the chain. For an auditor asking "has 1Claw shown me the real
history?", the honest answer today is *you are trusting 1Claw*.

That is the gap this contract closes. It removes 1Claw from its own trust
assumption without publishing a single audit event.

---

## 2. What we are not going to do

Three designs look like they solve this and do not. Each is worth naming,
because the contract's shape is a direct response to why they fail.

**Publish the log.** Solves verification, destroys the product. Audit logs
contain vault paths, agent identifiers, transaction destinations and policy
decisions. None of it can go on a public ledger.

**Publish a hash of the log.** The obvious next move, and it proves nothing. The
committer chooses both the log and the hash. Nothing prevents recomputing the
chain over a doctored history and publishing that hash instead. A commitment you
can freely recompute is a commitment to nothing.

**Prove knowledge of a preimage.** Wrapping the same idea in a ZK circuit — "I
know a value that hashes to the thing I published" — adds cryptography without
adding a claim. The prover picks both sides. Worse, with no authorization the
map is squattable: anyone can register any agent identifier and anchor garbage
under it.

The failure common to all three is that **the commitment is unconstrained by
history.** The fix is to make the relation between successive commitments the
thing the circuit enforces.

---

## 3. Construction

Three ledger maps, all keyed by an *agent commitment* rather than an agent
identifier:

```
commitments : Map<Bytes<32>, Bytes<32>>   // agentCommitment -> headTag(currentHead)
epochs      : Map<Bytes<32>, Uint<64>>    // agentCommitment -> anchor count
owners      : Map<Bytes<32>, Bytes<32>>   // agentCommitment -> ownerTag(secretKey)
```

where

```
agentCommitment = persistentHash([domainSep, agentId, registrationSalt])
```

and the salt never leaves the 1Claw vault. The ledger therefore names no agent.

Four values are witnesses — private inputs the circuit sees and the chain never
does: the owner's secret key, the previous chain head, the number of new events,
and the event hashes themselves.

### `anchorInitial`

Registers an agent: writes `ownerTag(sk)` into `owners`, `headTag(head)` into
`commitments`, and sets `epochs` to 1. It asserts the agent is not already
registered, which makes registration first-come and permanent.

The initial head is witness-only. Publishing it would leak the log's starting
state for no benefit, and would be inconsistent with `anchorExtend` keeping the
head private thereafter.

### `anchorExtend`

The circuit that carries the argument. Three assertions and a fold:

```
assert epochs.member(key)                              // agent is registered
assert ownerTag(sk)      == owners[key]                // caller owns this agent
assert headTag(prevHead) == commitments[key]           // prevHead is the anchored one
assert 0 < count <= 8                                  // batch is non-empty and bounded

head := foldStep(... foldStep(prevHead, e[0]) ..., e[count-1])

commitments[key] := headTag(head)
epochs[key]      := epochs[key] + 1
```

The second and third assertions are the whole design. Together they mean a new
commitment can only be written by someone who **holds the registered owner key**
and **can supply the head that is currently anchored**. The fold then derives the
new head from that verified starting point. There is no path that writes an
arbitrary value into `commitments`.

### Domain separation

`ownerTag` and `headTag` prefix distinct constants before hashing. Without them,
a 32-byte value meaningful in one map could be replayed into another — an owner
tag presented as a head commitment, or vice versa. The tags cost one hash each
and remove the class entirely.

### The unrolled fold

A circuit has no dynamic loop bound and Compact has no mutable locals, so the
fold is written out eight times, each step guarded:

```
h1 = 0 < count ? foldStep(h0, events[0]) : h0
h2 = 1 < count ? foldStep(h1, events[1]) : h1
...
```

The guards are load-bearing. The obvious alternative — requiring the caller to
zero unused slots — trusts a witness the circuit is meant to constrain. A
malicious prover could place real event hashes in slots past `count` and fold
them in silently. With the guards, slots at or beyond `count` cannot influence
the result at all. `trailing padding slots are inert` in the test suite is that
property, asserted directly.

Eight is a fixed cost, not a limit on throughput: anchoring is batched, and
raising the bound costs proving time linearly.

---

## 4. What this proves, and what it does not

The claim, stated precisely:

> For an agent registered at epoch 1, the value in `commitments` at epoch *n* is
> the head of a chain extended *n−1* times, each extension performed by the
> holder of the registered owner key, each starting from the head anchored by
> the previous extension.

An auditor holding the log can recompute the chain off-chain, apply
`headTag`, and compare against the ledger. Agreement means the log they were
shown is the log that was anchored — a fact 1Claw cannot retroactively alter,
because altering it requires rewriting ledger history.

**What it does not prove**, stated just as plainly:

- **Completeness.** The contract constrains how the chain advances, not that
  every event entered it. An event never folded in is invisible here. Anchoring
  frequency is what bounds the window in which an unanchored event can be
  quietly dropped; the contract cannot enforce that on its own.
- **Semantic truth.** That an event says what happened is a property of the
  system that wrote it, not of the anchor.
- **Owner-key custody.** Whoever holds the registered secret key can extend the
  anchor. The contract proves the extension was authorized, not that
  authorization was deserved. Key custody is 1Claw's vault problem, and is
  exactly the problem the vault exists to solve.
- **Liveness.** Nothing compels anchoring. A log that stops being anchored
  simply stops gaining this property, visibly — which is why `epochs` is public.

We would rather state these than have a judge find them.

---

## 5. Privacy

What a ledger observer learns:

| Visible | Not visible |
| --- | --- |
| An opaque 32-byte key exists | Which agent, org, or customer it is |
| It has been anchored *n* times | What any event contained |
| Roughly when each anchor happened | The chain head, at any epoch |
| An owner tag exists for it | The owner's key, or anything derived usefully from it |

`epochs` is public deliberately. "This log has been anchored *n* times" is the
liveness signal an auditor wants and leaks nothing about content — and hiding it
would remove the ability to notice that anchoring stopped, which is the failure
mode most worth noticing.

The residual leak is timing. An observer sees anchor frequency, which correlates
loosely with activity. Anchoring on a fixed schedule rather than on event volume
removes even that, at the cost of some empty anchors.

---

## 6. Testing

Twelve simulator tests run the compiled circuit through `QueryContext`, so they
exercise the same artifact that deploys rather than a re-implementation. Beyond
the happy path they pin the properties above:

- padding slots cannot influence the fold
- a wrong `prevHead` is rejected
- a wrong secret key is rejected
- an unregistered agent cannot be squatted
- an empty batch is rejected
- epochs increase monotonically
- the head itself is never published, only a commitment to it
- the off-chain TypeScript fold agrees with the circuit across a full batch

That last one matters more than it looks. The viewer and the anchoring client
both compute the fold off-chain, and two hand-written encodings of the same
relation drift. The test pins them to one definition.

---

## 7. Wave 2

- **Anchor on a schedule**, from the vault, so the completeness window is
  bounded by policy rather than by whoever remembers to anchor.
- **Selective disclosure.** Prove a *specific* event is in the anchored chain
  without revealing the rest — a Merkle path inside the circuit, rather than a
  linear fold, so an auditor can be shown one entry and verify it belongs.
- **Multi-org anchoring** in one transaction, amortizing proving cost.
- **Recovery.** Owner-key rotation is currently absent: a lost key means a
  permanently frozen anchor. A rotation circuit gated on the current key is the
  obvious fix and needs its own threat model first.

---

## Appendix — mapping to source

| Concept | File |
| --- | --- |
| Circuits and ledger declarations | [`contracts/audit-anchor/src/AuditAnchor.compact`](contracts/audit-anchor/src/AuditAnchor.compact) |
| Witness providers | [`contracts/audit-anchor/src/witnesses.ts`](contracts/audit-anchor/src/witnesses.ts) |
| Simulator harness | [`contracts/audit-anchor/src/test/AuditAnchorSimulator.ts`](contracts/audit-anchor/src/test/AuditAnchorSimulator.ts) |
| Property tests | [`contracts/audit-anchor/src/test/audit-anchor.test.ts`](contracts/audit-anchor/src/test/audit-anchor.test.ts) |
| Off-chain fold and ledger reader | [`demo/anchor-viewer/src/anchor.ts`](demo/anchor-viewer/src/anchor.ts) |
| Deployment | [`scripts/deploy-anchor.ts`](scripts/deploy-anchor.ts) |

Licensed Apache-2.0. See [README](README.md) for setup, funding and ecosystem
attribution.
