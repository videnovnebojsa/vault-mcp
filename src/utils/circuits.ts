import { CircuitBreaker, type CircuitBreakerOptions, configureCircuitBreakerAlerts } from "./circuit-breaker.js";

const registry = new Map<string, CircuitBreaker>();

const KNOWN_DEFAULTS: Record<string, CircuitBreakerOptions> = {
  "http-embed": { failureThreshold: 5, resetTimeoutMs: 60_000, windowMs: 60_000 },
};

export function getCircuit(name: string): CircuitBreaker {
  let cb = registry.get(name);
  if (!cb) {
    cb = new CircuitBreaker(name, KNOWN_DEFAULTS[name]);
    registry.set(name, cb);
  }
  return cb;
}

export function getAllCircuits(): Map<string, CircuitBreaker> {
  return registry;
}

export function resetAllCircuits(): void {
  for (const cb of registry.values()) cb.reset();
  registry.clear();
  configureCircuitBreakerAlerts("");
}
