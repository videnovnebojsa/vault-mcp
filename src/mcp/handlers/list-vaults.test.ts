import { describe, expect, it } from "bun:test";
import { handleVaultListVaults } from "./list-vaults.js";

describe("handleVaultListVaults", () => {
  it("returns list of vaults", async () => {
    const result = await handleVaultListVaults({}, [{ name: "default" }, { name: "work" }]);
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0]?.text ?? "{}").data;
    expect(data.vaults).toEqual([{ name: "default" }, { name: "work" }]);
  });

  it("returns empty list when no vaults configured", async () => {
    const result = await handleVaultListVaults({}, []);
    const data = JSON.parse(result.content[0]?.text ?? "{}").data;
    expect(data.vaults).toHaveLength(0);
  });
});
