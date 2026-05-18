import { describe, expect, it } from "bun:test";
import { formatErrorMessage, formatErrorResponse, VaultError, VaultErrorCode } from "./errors.js";

describe("VaultError", () => {
  it("creates an error with code and message", () => {
    const err = new VaultError("not found", VaultErrorCode.NOT_FOUND);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe("not found");
    expect(err.code).toBe(VaultErrorCode.NOT_FOUND);
    expect(err.name).toBe("VaultError");
  });

  it("stores cause", () => {
    const cause = new Error("original");
    const err = new VaultError("wrapped", VaultErrorCode.BOOT_FAILED, cause);
    expect(err.cause).toBe(cause);
  });
});

describe("formatErrorMessage", () => {
  it("formats VaultError with code prefix", () => {
    const err = new VaultError("path traversal detected", VaultErrorCode.PATH_TRAVERSAL);
    expect(formatErrorMessage(err)).toBe("[PATH_TRAVERSAL] path traversal detected");
  });

  it("formats plain Error with just message", () => {
    const err = new Error("something broke");
    expect(formatErrorMessage(err)).toBe("something broke");
  });

  it("formats non-Error as string", () => {
    expect(formatErrorMessage("some string")).toBe("some string");
    expect(formatErrorMessage(42)).toBe("42");
  });
});

describe("formatErrorResponse", () => {
  it("formats VaultError with its code", () => {
    const err = new VaultError("access denied", VaultErrorCode.ACL_VIOLATION);
    const resp = formatErrorResponse(err);
    expect(resp.error.code).toBe("ACL_VIOLATION");
    expect(resp.error.message).toBe("access denied");
  });

  it("formats plain Error with INTERNAL_ERROR code by default", () => {
    const err = new Error("oops");
    const resp = formatErrorResponse(err);
    expect(resp.error.code).toBe("INTERNAL_ERROR");
    expect(resp.error.message).toBe("oops");
  });

  it("uses .code property on plain Error when present", () => {
    const err = new Error("not found") as Error & { code: string };
    err.code = "ENOENT";
    const resp = formatErrorResponse(err);
    expect(resp.error.code).toBe("ENOENT");
  });

  it("formats non-Error values with INTERNAL_ERROR code", () => {
    const resp = formatErrorResponse("raw string error");
    expect(resp.error.code).toBe("INTERNAL_ERROR");
    expect(resp.error.message).toBe("raw string error");
  });
});
