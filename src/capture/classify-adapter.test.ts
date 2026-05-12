import { describe, expect, it } from "vitest";
import { classifyWithHeuristic } from "./classify-adapter.js";

describe("classifyWithHeuristic", () => {
  it("maps heuristic result to CaptureClassification", () => {
    const result = classifyWithHeuristic("Met with John about the project");
    expect(result.category).toBe("person");
    expect(result.confidence).toBe(0.7);
    expect(result.properties).toEqual({});
    expect(result.sensitivity).toBe("low");
  });

  it("returns unknown for unclassifiable text", () => {
    const result = classifyWithHeuristic("asdfghjkl");
    expect(result.category).toBe("unknown");
    expect(result.confidence).toBe(0.3);
  });
});
