import { describe, expect, it, mock } from "bun:test";
import type { VaultSync } from "../../search/sync.js";
import type { CaptureService, VaultManager } from "../../vault/manager.js";
import { handleVaultCapture } from "./capture.js";
import { makeServices, waitFor } from "./test-helpers.js";

describe("handleVaultCapture", () => {
  it("returns error when capture pipeline is not enabled", async () => {
    const services = makeServices({ capture: null });
    const vaultManager = { trackSync: mock() } as unknown as VaultManager;

    const result = await handleVaultCapture({ text: "some text", vault: "default" }, services, vaultManager);
    expect(result.isError).toBe(true);
    const data = JSON.parse(result.content[0]?.text ?? "{}");
    expect(data.error.message).toContain("Capture pipeline is disabled");
  });

  it("processes capture when pipeline is enabled", async () => {
    const processCapture = mock().mockResolvedValue({
      ok: true,
      notePath: "00_Inbox/captured.md",
      classification: { category: "idea", confidence: 0.8, suggested_title: "Idea", tags: [] },
      message: "Captured",
    });
    const mockCapture = { processCapture } as unknown as CaptureService;
    const vaultSync = { handleUpsert: mock().mockResolvedValue(undefined) } as unknown as VaultSync;
    const trackSync = mock();
    const services = makeServices({ capture: mockCapture, vaultSync });
    const vaultManager = { trackSync } as unknown as VaultManager;

    const result = await handleVaultCapture({ text: "an interesting idea", vault: "default" }, services, vaultManager);
    expect(result.isError).toBeFalsy();
    expect(processCapture).toHaveBeenCalledWith("an interesting idea");
    const data = JSON.parse(result.content[0]?.text ?? "{}").data;
    expect(data.path).toBe("00_Inbox/captured.md");
    expect(data.notePath).toBeUndefined();
    await waitFor(() => expect(trackSync).toHaveBeenCalled());
  });
});
