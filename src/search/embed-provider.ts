import { getCircuit } from "../utils/circuits.js";
import { logger } from "../utils/logger.js";
import { RetryableError, withRetry } from "../utils/retry.js";

export interface EmbedProvider {
  embed(texts: string[]): Promise<Float32Array[]>;
  readonly dimensions: number;
  readonly modelName: string;
}

interface EmbeddingResponse {
  data: Array<{ embedding: number[]; index: number }>;
  model: string;
  usage?: { prompt_tokens?: number; total_tokens?: number };
}

export class DeepSeekEmbedProvider implements EmbedProvider {
  private _dimensions = 0;

  constructor(
    private readonly apiKey: string,
    private readonly endpoint: string,
    readonly modelName: string,
  ) {}

  get dimensions(): number {
    return this._dimensions;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    if (!this.endpoint) {
      throw new Error(
        "EMBEDDING_ENDPOINT is not configured — set it to your embedding provider URL (e.g. https://api.openai.com/v1)",
      );
    }

    const circuit = getCircuit("deepseek-embed");

    return circuit.execute(() =>
      withRetry(
        async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 30_000);

          try {
            const res = await fetch(`${this.endpoint}/embeddings`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${this.apiKey}`,
              },
              body: JSON.stringify({ model: this.modelName, input: texts }),
              signal: controller.signal,
            });

            if (!res.ok) {
              const body = await res.text().catch(() => "");
              logger.error("embed-provider", "API error", { status: res.status, body });
              throw new RetryableError(`Embedding API error ${res.status}`, res.status);
            }

            const json = (await res.json()) as EmbeddingResponse;

            // Sort by index to match input order
            const sorted = json.data.sort((a, b) => a.index - b.index);
            const results = sorted.map((d) => new Float32Array(d.embedding));

            // Cache dimensions from first response
            if (this._dimensions === 0 && results.length > 0) {
              this._dimensions = results[0]?.length ?? 0;
            }

            return results;
          } finally {
            clearTimeout(timer);
          }
        },
        { maxAttempts: 3 },
      ),
    );
  }
}

/**
 * Mock provider that returns random unit vectors. Used when embeddings are disabled.
 */
export class MockEmbedProvider implements EmbedProvider {
  readonly dimensions: number;
  readonly modelName = "mock";

  constructor(dimensions = 256) {
    this.dimensions = dimensions;
  }

  async embed(texts: string[]): Promise<Float32Array[]> {
    return texts.map(() => {
      const vec = new Float32Array(this.dimensions);
      let norm = 0;
      for (let i = 0; i < this.dimensions; i++) {
        vec[i] = Math.random() * 2 - 1;
        norm += (vec[i] ?? 0) * (vec[i] ?? 0);
      }
      norm = Math.sqrt(norm);
      for (let i = 0; i < this.dimensions; i++) {
        vec[i] = (vec[i] ?? 0) / norm;
      }
      return vec;
    });
  }
}
