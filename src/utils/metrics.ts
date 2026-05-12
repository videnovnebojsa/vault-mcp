interface ToolMetrics {
  count: number;
  errors: number;
  /** Circular buffer of the last MAX_LATENCIES duration values (ms). */
  latencies: number[];
  latencyHead: number;
}

const MAX_LATENCIES = 1000;

export class MetricsStore {
  private readonly store = new Map<string, ToolMetrics>();

  record(toolName: string, durationMs: number, isError: boolean): void {
    let m = this.store.get(toolName);
    if (!m) {
      m = { count: 0, errors: 0, latencies: new Array<number>(MAX_LATENCIES).fill(0), latencyHead: 0 };
      this.store.set(toolName, m);
    }
    m.count++;
    if (isError) m.errors++;
    m.latencies[m.latencyHead % MAX_LATENCIES] = durationMs;
    m.latencyHead++;
  }

  snapshot(): Record<string, { count: number; errors: number; p50: number; p95: number; p99: number }> {
    const out: Record<string, { count: number; errors: number; p50: number; p95: number; p99: number }> = {};
    for (const [name, m] of this.store) {
      const filled = Math.min(m.count, MAX_LATENCIES);
      const sorted = m.latencies.slice(0, filled).sort((a, b) => a - b);
      out[name] = {
        count: m.count,
        errors: m.errors,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        p99: percentile(sorted, 0.99),
      };
    }
    return out;
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.max(0, Math.ceil(sorted.length * p) - 1);
  return sorted[idx] ?? 0;
}

/** Singleton metrics store, safe for module-level import. */
export const metrics = new MetricsStore();
