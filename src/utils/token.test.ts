import { describe, expect, it } from "bun:test";
import { isValidToken } from "./token.js";

describe("isValidToken", () => {
  it("returns true for matching token", () => {
    expect(isValidToken("correct-secret", "correct-secret")).toBe(true);
  });

  it("returns false for wrong token of same length", () => {
    expect(isValidToken("wrong-secret!!", "correct-secret")).toBe(false);
  });

  it("returns false for token with different length", () => {
    expect(isValidToken("short", "correct-secret")).toBe(false);
    expect(isValidToken("this-is-a-much-longer-token", "correct-secret")).toBe(false);
  });

  it("returns false for undefined token", () => {
    expect(isValidToken(undefined, "correct-secret")).toBe(false);
  });

  it("returns false when expected key is empty string (auth disabled guard)", () => {
    expect(isValidToken("anything", "")).toBe(false);
    expect(isValidToken("secret", "")).toBe(false);
    expect(isValidToken("", "")).toBe(false);
  });
});
