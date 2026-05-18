import { describe, expect, it } from "bun:test";
import { resolveBunBinaryName } from "./bun-binary-name.js";

describe("resolveBunBinaryName", () => {
  it("rejects path traversal in BUN_BINARY_NAME [SEC-05]", () => {
    expect(() => resolveBunBinaryName("../vault-mcp")).toThrow("BUN_BINARY_NAME must be a file name");
    expect(() => resolveBunBinaryName("nested/vault-mcp")).toThrow("BUN_BINARY_NAME must be a file name");
  });
});
