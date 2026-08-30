/**
 * Liveness rules for a wallet sync, kept separate from the deploy script so
 * they can be exercised without a chain, a wallet, or an hour of waiting.
 *
 * They are here because they were wrong twice. The first version keyed on
 * `synced`/`total`, which are not fields on SyncProgress — and because these
 * are prototype getters, a wrong name yields `undefined` rather than an error,
 * so the fingerprint was constant and the watchdog would have fired on every
 * healthy sync. The second version used the right names and still could not be
 * trusted, because Preprod leaves `highestIndex` empty: a real field that is
 * simply never populated is indistinguishable from a wrong one.
 *
 * Hence the central rule: a no-progress timeout is only meaningful once the
 * fingerprint has been *observed to change*. Until then the connection signal,
 * which does report, is the only guard.
 */

/** The fields SyncProgress actually carries (wallet-sdk-abstractions). */
export type Progress = {
  appliedIndex?: bigint;
  highestIndex?: bigint;
  highestRelevantIndex?: bigint;
  isConnected?: boolean;
};

export type ObservedState = {
  unshielded?: { progress?: Progress; availableCoins?: unknown[] };
  dust?: { progress?: Progress };
  shielded?: { progress?: Progress };
};

export type Verdict = { kind: "healthy" } | { kind: "stalled"; reason: string };

export type LivenessOptions = {
  /** No forward movement for this long is wedged — once progress is trusted. */
  stallMs: number;
  /** A reported disconnect this long is the drop itself, not a blip. */
  disconnectMs: number;
  /**
   * No state emission at all for this long. Distinct from a disconnect: the
   * original failure was a stream that simply went quiet for seventy minutes,
   * and calling that "disconnected" names the wrong thing. Wider than
   * disconnectMs because the first emission after a checkpoint restore can lag.
   */
  silenceMs: number;
};

/**
 * All three sub-wallets contribute: the shielded Merkle scan can run for
 * minutes while the unshielded index sits still, and treating that as a stall
 * would restart a sync that is making progress.
 */
export function fingerprint(state: ObservedState): string {
  return [state.unshielded?.progress, state.dust?.progress, state.shielded?.progress]
    .map((p) => `${p?.appliedIndex ?? -1n}/${p?.highestIndex ?? -1n}`)
    .join(":");
}

/** False when any sub-wallet explicitly reports a lost connection. */
export function isConnected(state: ObservedState): boolean {
  return [state.unshielded?.progress, state.dust?.progress, state.shielded?.progress].every(
    (p) => p?.isConnected !== false,
  );
}

export class SyncLiveness {
  readonly #stallMs: number;
  readonly #disconnectMs: number;
  readonly #silenceMs: number;
  #lastAdvance: number;
  #lastConnected: number;
  #lastObserved: number;
  #fingerprint = "";
  #sawFirst = false;
  #progressIsLive = false;
  #connected = true;

  constructor(opts: LivenessOptions, startedAt: number) {
    this.#stallMs = opts.stallMs;
    this.#disconnectMs = opts.disconnectMs;
    this.#silenceMs = opts.silenceMs;
    this.#lastAdvance = startedAt;
    this.#lastConnected = startedAt;
    this.#lastObserved = startedAt;
  }

  /** Whether the fingerprint has ever moved, and so can be trusted. */
  get progressIsLive(): boolean {
    return this.#progressIsLive;
  }

  get connected(): boolean {
    return this.#connected;
  }

  observe(state: ObservedState, now: number): void {
    const fp = fingerprint(state);
    if (fp !== this.#fingerprint) {
      // The first sample establishes a baseline; it is not yet evidence of
      // movement, so it must not arm the timeout on its own.
      if (this.#sawFirst) this.#progressIsLive = true;
      this.#sawFirst = true;
      this.#fingerprint = fp;
      this.#lastAdvance = now;
    }
    this.#lastObserved = now;
    this.#connected = isConnected(state);
    if (this.#connected) this.#lastConnected = now;
  }

  verdict(now: number): Verdict {
    // Silence first, and named as itself: a stream that has stopped emitting is
    // not the same as one reporting a lost connection, and the two want
    // different investigations even though both warrant a restart.
    if (now - this.#lastObserved > this.#silenceMs) {
      return {
        kind: "stalled",
        reason: `no state emissions for ${Math.round(this.#silenceMs / 1000)}s`,
      };
    }
    // A disconnect is only knowable while samples are still arriving. With a
    // quiet stream `lastConnected` goes stale too, and reporting that as a
    // disconnect would let silence wear the narrower window's label — which is
    // exactly what it did before this guard.
    if (!this.#connected && now - this.#lastConnected > this.#disconnectMs) {
      return {
        kind: "stalled",
        reason: `indexer disconnected for ${Math.round(this.#disconnectMs / 1000)}s`,
      };
    }
    if (this.#progressIsLive && now - this.#lastAdvance > this.#stallMs) {
      return {
        kind: "stalled",
        reason: `no sync progress for ${Math.round(this.#stallMs / 60000)}m`,
      };
    }
    return { kind: "healthy" };
  }
}
