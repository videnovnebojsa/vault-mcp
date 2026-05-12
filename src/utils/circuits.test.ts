import { beforeEach, describe, expect, it } from "vitest";
import { getAllCircuits, getCircuit, resetAllCircuits } from "./circuits.js";

describe("circuits registry", () => {
  beforeEach(() => {
    resetAllCircuits();
  });

  it("returns same instance for same name", () => {
    const a = getCircuit("todoist");
    const b = getCircuit("todoist");
    expect(a).toBe(b);
  });

  it("returns different instances for different names", () => {
    const a = getCircuit("todoist");
    const b = getCircuit("deepseek");
    expect(a).not.toBe(b);
  });

  it("uses known defaults for predefined names", () => {
    const cb = getCircuit("todoist");
    expect(cb.name).toBe("todoist");
  });

  it("creates circuit with standard defaults for unknown names", () => {
    const cb = getCircuit("custom-service");
    expect(cb.name).toBe("custom-service");
    expect(cb.state).toBe("closed");
  });

  it("getAllCircuits returns all created circuits", () => {
    getCircuit("todoist");
    getCircuit("deepseek");
    const all = getAllCircuits();
    expect(all.size).toBe(2);
    expect(all.has("todoist")).toBe(true);
    expect(all.has("deepseek")).toBe(true);
  });

  it("resetAllCircuits clears registry", () => {
    getCircuit("todoist");
    getCircuit("deepseek");
    resetAllCircuits();
    expect(getAllCircuits().size).toBe(0);
  });
});
