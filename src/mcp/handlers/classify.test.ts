import { describe, expect, it } from "bun:test";
import { handleVaultClassify } from "./classify.js";
import { makeServices } from "./test-helpers.js";

describe("handleVaultClassify", () => {
  it("classifies text and returns category and folder", async () => {
    const services = makeServices();
    const result = await handleVaultClassify(
      { text: "Met with Alice to discuss the project milestone", vault: "default" },
      services,
      undefined,
    );
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text ?? "{}").data;
    expect(data.category).toBeTruthy();
    expect(data.suggested_folder).toBeTruthy();
    expect(data.confidence).toBeGreaterThan(0);
  });

  it("uses default rules when no custom rules provided", async () => {
    const services = makeServices();
    const result = await handleVaultClassify(
      { text: "idea: what if we added semantic search", vault: "default" },
      services,
      undefined,
    );
    const data = JSON.parse(result.content[0]?.text ?? "{}").data;
    expect(data.category).toBe("idea");
    expect(data.suggested_folder).toBe("30_Zettelkasten");
  });
});
