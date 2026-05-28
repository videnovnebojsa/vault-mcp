import { describe, expect, it, spyOn } from "bun:test";

describe("search store import", () => {
  it("does not allocate the backup worker object URL at module import [PERF-03]", async () => {
    const createObjectURL = spyOn(URL, "createObjectURL");

    try {
      await import("./store.js");
      expect(createObjectURL).not.toHaveBeenCalled();
    } finally {
      createObjectURL.mockRestore();
    }
  });
});
