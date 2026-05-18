import { describe, expect, it, mock } from "bun:test";
import { trackDelete } from "./sync-tracking.js";

describe("trackDelete", () => {
  it("tracks delete sync work through the shared sync tracker", async () => {
    const tracked: Promise<void>[] = [];
    const syncTracker = {
      trackSync: mock((promise: Promise<void>) => {
        tracked.push(promise);
      }),
    };
    const vaultSync = { handleDelete: mock().mockReturnValue(true) };

    trackDelete(syncTracker, vaultSync, "notes/a.md", "delete sync failed");

    expect(syncTracker.trackSync).toHaveBeenCalledOnce();
    await Promise.all(tracked);
    expect(vaultSync.handleDelete).toHaveBeenCalledWith("notes/a.md");
  });
});
