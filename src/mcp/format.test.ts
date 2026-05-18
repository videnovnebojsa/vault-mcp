import { describe, expect, it } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { VaultError, VaultErrorCode } from "../utils/errors.js";
import { errorResult, listResult, successResult, toClientNote } from "./format.js";

describe("toClientNote", () => {
  it("strips absPath from notes returned to MCP clients", () => {
    const note = {
      path: "notes/a.md",
      absPath: "/vault/notes/a.md",
      name: "a.md",
      content: "content",
      raw: "content",
      frontmatter: {},
    };

    const clientNote = toClientNote(note);

    expect(clientNote).toEqual({
      path: "notes/a.md",
      name: "a.md",
      content: "content",
      raw: "content",
      frontmatter: {},
    });
    expect(clientNote).not.toHaveProperty("absPath");
  });
});

describe("successResult", () => {
  it("wraps data in ok:true envelope", () => {
    const result = successResult({ foo: "bar" });
    const parsed = JSON.parse(result.content[0]?.text ?? "{}");
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toEqual({ foo: "bar" });
    expect(parsed.foo).toBeUndefined();
    expect(result.isError).toBeUndefined();
  });

  it("does not let nested ok fields collide with the envelope ok", () => {
    const result = successResult({ ok: false, path: "failed.md" });
    const parsed = JSON.parse(result.content[0]?.text ?? "{}");
    expect(parsed.ok).toBe(true);
    expect(parsed.data.ok).toBe(false);
  });

  it("handles null data", () => {
    const result = successResult(null);
    const parsed = JSON.parse(result.content[0]?.text ?? "{}");
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toBeNull();
  });

  it("handles array data", () => {
    const result = successResult([1, 2, 3]);
    const parsed = JSON.parse(result.content[0]?.text ?? "{}");
    expect(parsed.ok).toBe(true);
    expect(parsed.data).toEqual([1, 2, 3]);
  });

  it("serializes success envelopes without pretty-print indentation", () => {
    const result = successResult({ foo: "bar" });
    expect(result.content[0]?.text).toBe('{"ok":true,"data":{"foo":"bar"}}');
  });
});

describe("listResult", () => {
  it("returns items with a known-total pagination descriptor", () => {
    const result = listResult([{ id: 1 }], { kind: "knownTotal", total: 3, offset: 0, limit: 1 });
    const parsed = JSON.parse(result.content[0]?.text ?? "{}");
    expect(parsed.items).toEqual([{ id: 1 }]);
    expect(parsed.total).toBe(3);
    expect(parsed.hasMore).toBe(true);
    expect(parsed.nextOffset).toBe(1);
  });

  it("returns items with total and hasMore=false when all fit", () => {
    const items = [{ id: 1 }, { id: 2 }];
    const result = listResult(items, { kind: "knownTotal", total: 2, offset: 0, limit: 10 });
    const parsed = JSON.parse(result.content[0]?.text ?? "{}");
    expect(parsed.ok).toBe(true);
    expect(parsed.items).toEqual(items);
    expect(parsed.total).toBe(2);
    expect(parsed.hasMore).toBe(false);
    expect(parsed.nextOffset).toBeUndefined();
    expect(result.isError).toBeUndefined();
  });

  it("sets hasMore=true and nextOffset when more pages remain", () => {
    const items = [{ id: 1 }, { id: 2 }];
    const result = listResult(items, { kind: "knownTotal", total: 10, offset: 0, limit: 5 });
    const parsed = JSON.parse(result.content[0]?.text ?? "{}");
    expect(parsed.hasMore).toBe(true);
    expect(parsed.nextOffset).toBe(5);
  });

  it("sets hasMore=true with correct nextOffset when using offset>0", () => {
    const items = [{ id: 6 }, { id: 7 }];
    const result = listResult(items, { kind: "knownTotal", total: 10, offset: 5, limit: 2 });
    const parsed = JSON.parse(result.content[0]?.text ?? "{}");
    expect(parsed.hasMore).toBe(true);
    expect(parsed.nextOffset).toBe(7); // offset + limit = 5 + 2
  });

  it("returns empty items list correctly", () => {
    const result = listResult([], { kind: "knownTotal", total: 0, offset: 0, limit: 10 });
    const parsed = JSON.parse(result.content[0]?.text ?? "{}");
    expect(parsed.ok).toBe(true);
    expect(parsed.items).toEqual([]);
    expect(parsed.total).toBe(0);
    expect(parsed.hasMore).toBe(false);
  });

  it("calculates hasMore based on offset+items.length vs total", () => {
    // offset=8, items.length=2, total=10 → 8+2=10 not < 10 → hasMore=false
    const result = listResult([{ id: 9 }, { id: 10 }], { kind: "knownTotal", total: 10, offset: 8, limit: 5 });
    const parsed = JSON.parse(result.content[0]?.text ?? "{}");
    expect(parsed.hasMore).toBe(false);
    expect(parsed.nextOffset).toBeUndefined();
  });

  it("sets hasMore=true and nextOffset for unknown totals", () => {
    const result = listResult([{ id: 1 }], { kind: "unknownTotal", offset: 20, limit: 10, hasMore: true });
    const parsed = JSON.parse(result.content[0]?.text ?? "{}");
    expect(parsed.ok).toBe(true);
    expect(parsed.items).toEqual([{ id: 1 }]);
    expect(parsed.total).toBeNull();
    expect(parsed.hasMore).toBe(true);
    expect(parsed.nextOffset).toBe(30);
  });

  it("omits nextOffset for unknown totals when hasMore is false", () => {
    const result = listResult([{ id: 1 }], { kind: "unknownTotal", offset: 20, limit: 10, hasMore: false });
    const parsed = JSON.parse(result.content[0]?.text ?? "{}");
    expect(parsed.ok).toBe(true);
    expect(parsed.total).toBeNull();
    expect(parsed.hasMore).toBe(false);
    expect(parsed.nextOffset).toBeUndefined();
  });

  it("throws a validation VaultError when unknown totals omit hasMore", () => {
    const unsafeListResult = listResult as (...args: unknown[]) => unknown;
    expect(() => unsafeListResult([], null, 0, 10)).toThrow(VaultError);
    expect(() => unsafeListResult([], null, 0, 10)).toThrow(
      expect.objectContaining({ code: VaultErrorCode.VALIDATION }),
    );
  });

  it("serializes list envelopes without pretty-print indentation", () => {
    const result = listResult([{ id: 1 }], { kind: "knownTotal", total: 1, offset: 0, limit: 10 });
    expect(result.content[0]?.text).toBe('{"ok":true,"items":[{"id":1}],"total":1,"hasMore":false}');
  });

  it("assigns nextOffset directly instead of using a conditional spread", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/mcp/format.ts"), "utf8");
    expect(source).not.toContain("...(hasMore ? { nextOffset");
  });

  it("documents the exported pagination descriptor type", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/mcp/format.ts"), "utf8");
    expect(source).toMatch(/\/\*\*[\s\S]*unknownTotal[\s\S]*export type ListResultPagination/);
  });

  it("does not use the vague unknown-total hasMore test name", () => {
    const source = fs.readFileSync(path.join(process.cwd(), "src/mcp/format.test.ts"), "utf8");
    const oldName = ["supports unknown totals", " with explicit hasMore"].join("");
    expect(source).not.toContain(oldName);
  });
});

describe("errorResult", () => {
  it("returns ok:false with code and message", () => {
    const result = errorResult("NOT_FOUND", "Note not found");
    const parsed = JSON.parse(result.content[0]?.text ?? "{}");
    expect(parsed.ok).toBe(false);
    expect(parsed.error.code).toBe("NOT_FOUND");
    expect(parsed.error.message).toBe("Note not found");
    expect(result.isError).toBe(true);
  });

  it("sets isError=true", () => {
    const result = errorResult("SOME_CODE", "Some message");
    expect(result.isError).toBe(true);
  });

  it("serializes error envelopes without pretty-print indentation", () => {
    const result = errorResult("NOT_FOUND", "Note not found");
    expect(result.content[0]?.text).toBe('{"ok":false,"error":{"code":"NOT_FOUND","message":"Note not found"}}');
  });
});
