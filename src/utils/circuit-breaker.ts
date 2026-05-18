import { sendAlertFireAndForget } from "./alert-fire-and-forget.js";
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
  windowMs?: number; // failure counting window (default: 60s)
}

export interface CircuitSnapshot {
  state: CircuitState;
  failureCount: number;
  lastFailureAt: string | null;
  lastSuccessAt: string | null;
}

let alertWebhookUrl = "";

export function configureCircuitBreakerAlerts(webhookUrl: string): void {
  alertWebhookUrl = webhookUrl;
}

export class CircuitBreaker {
  private _state: CircuitState = "closed";
  private _failureTimes: number[] = []; // timestamps within the window
  private _openedAt = 0;
  private _lastFailureAt: number | null = null;
  private _lastSuccessAt: number | null = null;

  private readonly failureThreshold: number;
  private readonly resetTimeoutMs: number;
  private readonly windowMs: number;

  constructor(
    public readonly name: string,
    opts?: CircuitBreakerOptions,
  ) {
    this.failureThreshold = opts?.failureThreshold ?? 5;
    this.resetTimeoutMs = opts?.resetTimeoutMs ?? 60_000;
    this.windowMs = opts?.windowMs ?? 60_000;
  }

  get state(): CircuitState {
    return this._state;
  }

  get failureCount(): number {
    return this._failureTimes.length;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this.transitionToHalfOpenIfReady();
    const currentState = this._state;

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
    // Compute the effective state without mutating the breaker. The actual
    // transition happens explicitly when execute() attempts a probe.
    const displayState: CircuitState =
      this._state === "open" && Date.now() - this._openedAt >= this.resetTimeoutMs ? "half-open" : this._state;
    return {
      state: displayState,
      failureCount: this._failureTimes.length,
      lastFailureAt: this._lastFailureAt ? new Date(this._lastFailureAt).toISOString() : null,
      lastSuccessAt: this._lastSuccessAt ? new Date(this._lastSuccessAt).toISOString() : null,
    };
  }

  reset(): void {
    this._state = "closed";
    this._failureTimes = [];
    this._openedAt = 0;
  }

  private _onSuccess(): void {
    this._lastSuccessAt = Date.now();
    if (this._state === "half-open") {
      // Only reset on explicit recovery from half-open → closed
      this._state = "closed";
      this._failureTimes = [];
      logger.info("circuit-breaker", "closed (recovered)", { name: this.name });
    }
    // In closed state: do NOT reset _failureTimes — they age out naturally
  }

  private transitionToHalfOpenIfReady(): void {
    if (this._state === "open" && Date.now() - this._openedAt >= this.resetTimeoutMs) {
      this._state = "half-open";
      logger.info("circuit-breaker", "half-open (probing)", { name: this.name });
    }
  }

  private _onFailure(): void {
    const now = Date.now();
    this._lastFailureAt = now;

    // Evict failures older than the window
    this._failureTimes = this._failureTimes.filter((t) => now - t < this.windowMs);
    this._failureTimes.push(now);

    const recentFailures = this._failureTimes.length;

    if (this._state === "half-open") {
      this._state = "open";
      this._openedAt = now;
      logger.warn("circuit-breaker", "re-opened (half-open probe failed)", {
        name: this.name,
        recentFailures,
      });
      this._alertOpen("re-opened");
    } else if (recentFailures >= this.failureThreshold) {
      this._state = "open";
      this._openedAt = now;
      logger.warn("circuit-breaker", "opened", {
        name: this.name,
        recentFailures,
        windowMs: this.windowMs,
      });
      this._alertOpen("opened");
    }
  }

  private _alertOpen(event: "opened" | "re-opened"): void {
    if (!alertWebhookUrl) return;
    sendAlertFireAndForget({
      webhookUrl: alertWebhookUrl,
      level: "error",
      source: "circuit-breaker",
      message: `Circuit ${event}: ${this.name}`,
      details: {
        name: this.name,
        state: this._state,
        failureCount: this._failureTimes.length,
        windowMs: this.windowMs,
      },
    });
  }
}
