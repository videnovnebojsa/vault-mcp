import { describe, expect, it } from "bun:test";
import { beginSpan } from "./span.js";

describe("beginSpan", () => {
  it("returns an object with an id string field", () => {
    const span = beginSpan("vault_read_note", "default");
    expect(span).toHaveProperty("id");
    expect(typeof span.id).toBe("string");
    expect(span.id.length).toBeGreaterThan(0);
  });

  it("exposes an end() method", () => {
    const span = beginSpan("vault_write_note", "myVault");
    expect(typeof span.end).toBe("function");
    expect(() => span.end()).not.toThrow();
  });

  it("end() does not throw when called with an error", () => {
    const span = beginSpan("vault_search", "default");
    expect(() => span.end(new Error("something went wrong"))).not.toThrow();
  });

  it("each beginSpan call returns a unique id", () => {
    const span1 = beginSpan("vault_read_note", "default");
    const span2 = beginSpan("vault_read_note", "default");
    expect(span1.id).not.toBe(span2.id);
  });
});
