import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { resetAllCircuits } from "../utils/circuits.js";
import { HttpEmbedProvider, MockEmbedProvider } from "./embed-provider.js";

describe("MockEmbedProvider", () => {
  it("returns vectors of correct dimensions", async () => {
    const provider = new MockEmbedProvider(128);
    const results = await provider.embed(["hello", "world"]);

    expect(results.length).toBe(2);
    expect(results[0].length).toBe(128);
    expect(results[1].length).toBe(128);
  });

  it("returns unit vectors (norm ≈ 1)", async () => {
    const provider = new MockEmbedProvider(64);
    const [vec] = await provider.embed(["test"]);

    let norm = 0;
    for (let i = 0; i < vec.length; i++) {
      norm += vec[i] * vec[i];
    }
    norm = Math.sqrt(norm);
    expect(norm).toBeCloseTo(1.0, 3);
  });

  it("returns empty array for empty input", async () => {
    const provider = new MockEmbedProvider();
    const results = await provider.embed([]);
    expect(results.length).toBe(0);
  });

  it("has correct model name and dimensions", () => {
    const provider = new MockEmbedProvider(256);
    expect(provider.modelName).toBe("mock");
    expect(provider.dimensions).toBe(256);
  });
});

describe("HttpEmbedProvider", () => {
  const makeProvider = () => new HttpEmbedProvider("sk-test", "https://api.example.com/v1", "text-embedding-3-small");

  beforeEach(() => {
    resetAllCircuits();
  });

  afterEach(() => {
    mock.restore();
    resetAllCircuits();
  });

  it("returns empty array for empty input without calling fetch", async () => {
    const spy = spyOn(globalThis, "fetch");
    const result = await makeProvider().embed([]);
    expect(result).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it("throws when EMBEDDING_ENDPOINT is empty", async () => {
    const provider = new HttpEmbedProvider("sk-test", "", "model");
    await expect(provider.embed(["hello"])).rejects.toThrow("EMBEDDING_ENDPOINT");
  });

  it("returns Float32Array vectors on success", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
          model: "text-embedding-3-small",
        }),
        { status: 200 },
      ),
    );
    const result = await makeProvider().embed(["hello"]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBeInstanceOf(Float32Array);
    expect(result[0]?.[0]).toBeCloseTo(0.1);
  });

  it("sets dimensions from first response", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [{ embedding: [0.1, 0.2, 0.3], index: 0 }],
          model: "text-embedding-3-small",
        }),
        { status: 200 },
      ),
    );
    const provider = makeProvider();
    expect(provider.dimensions).toBe(0);
    await provider.embed(["hello"]);
    expect(provider.dimensions).toBe(3);
  });

  it("throws a RetryableError on non-ok HTTP response", async () => {
    // Use AbortError (non-retryable in withRetry) so the test exits immediately without retry delays.
    const err = Object.assign(new Error("fetch failed"), { name: "AbortError" });
    spyOn(globalThis, "fetch").mockRejectedValueOnce(err);
    await expect(makeProvider().embed(["test"])).rejects.toThrow(/fetch failed/i);
  });

  it("propagates 400 client errors immediately (non-retryable)", async () => {
    spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("bad request", { status: 400 }));
    await expect(makeProvider().embed(["test"])).rejects.toThrow(/400/);
  });

  it("does not log the embedding API error body verbatim", async () => {
    const errorSpy = spyOn(console, "error").mockImplementation(() => {});
    spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("upstream secret body: sk-live-sensitive-token", { status: 400 }),
    );

    await expect(makeProvider().embed(["test"])).rejects.toThrow(/400/);

    expect(JSON.stringify(errorSpy.mock.calls)).not.toContain("sk-live-sensitive-token");
  });

  it("rejects immediately when circuit is open (no fetch called)", async () => {
    const { getCircuit } = await import("../utils/circuits.js");
    const circuit = getCircuit("http-embed");

    // Open the circuit by manually recording failures
    for (let i = 0; i < 5; i++) {
      // biome-ignore lint/suspicious/noExplicitAny: internal test access
      (circuit as any)._failureCount = 5;
      // biome-ignore lint/suspicious/noExplicitAny: internal test access
      (circuit as any)._state = "open";
      // biome-ignore lint/suspicious/noExplicitAny: internal test access
      (circuit as any)._openedAt = Date.now();
    }

    const spy = spyOn(globalThis, "fetch");
    await expect(makeProvider().embed(["hello"])).rejects.toThrow(/Circuit/i);
    expect(spy).not.toHaveBeenCalled();
  });
});
