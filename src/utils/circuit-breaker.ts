import { logger } from "./logger.js";

export type CircuitState = "closed" | "open" | "half-open";

export class CircuitOpenError extends Error {
  constructor(public readonly circuitName: string) {
    super(`Circuit "${circuitName}" is open — request rejected`);
    this.name = "CircuitOpenError";
  }
}

export interface CircuitBreakerOptions {
  failureThreshold?: number;
  resetTimeoutMs?: number;
}

export interface CircuitSnapshot {
  state: CircuitState;
  failureCount: number;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
}

export class CircuitBreaker {
  private _state: CircuitState = "closed";
  private _failureCount = 0;
  private _openedAt = 0;
  private _lastFailureAt: number | null = null;
  private _lastSuccessAt: number | null = null;

  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;

  constructor(
    public readonly name: string,
    opts?: CircuitBreakerOptions,
  ) {
    this.failureThreshold = opts?.failureThreshold ?? 5;
    this.resetTimeoutMs = opts?.resetTimeoutMs ?? 60_000;
  }

  get state(): CircuitState {
    if (this._state === "open" && Date.now() - this._openedAt >= this.resetTimeoutMs) {
      this._state = "half-open";
      logger.info("circuit-breaker", "half-open (probing)", { name: this.name });
    }
    return this._state;
  }

  get failureCount(): number {
    return this._failureCount;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    const currentState = this.state; // triggers open → half-open transition

    if (currentState === "open") {
      throw new CircuitOpenError(this.name);
    }

    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (err) {
      this._onFailure();
      throw err;
    }
  }

  snapshot(): CircuitSnapshot {
    return {
      state: this.state,
      failureCount: this._failureCount,
      lastFailureAt: this._lastFailureAt ? new Date(this._lastFailureAt).toISOString() : null,
      lastSuccessAt: this._lastSuccessAt ? new Date(this._lastSuccessAt).toISOString() : null,
    };
  }

  reset(): void {
    this._state = "closed";
    this._failureCount = 0;
    this._openedAt = 0;
  }

  private _onSuccess(): void {
    this._lastSuccessAt = Date.now();
    if (this._state === "half-open") {
      this._state = "closed";
      logger.warn("circuit-breaker", "closed (recovered)", { name: this.name });
    }
    // Reset failure count on any success — prevents scattered transient errors
    // from accumulating and eventually tripping the circuit
    this._failureCount = 0;
  }

  private _onFailure(): void {
    this._lastFailureAt = Date.now();
    this._failureCount++;
    if (this._state === "half-open") {
      this._state = "open";
      this._openedAt = Date.now();
      logger.warn("circuit-breaker", "opened", { name: this.name, failureCount: this._failureCount });
    } else if (this._failureCount >= this.failureThreshold) {
      this._state = "open";
      this._openedAt = Date.now();
      logger.warn("circuit-breaker", "opened", { name: this.name, failureCount: this._failureCount });
    }
  }
}
