import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { VaultSync } from "./sync.js";
import { createVaultWatcher, type VaultWatcher } from "./watcher.js";

function createMockVaultSync() {
  return {
    handleUpsert: mock<(p: string) => Promise<void>>().mockResolvedValue(undefined),
    handleDelete: mock<(p: string) => boolean>().mockReturnValue(true),
    handleRename: mock<(o: string, n: string) => Promise<void>>().mockResolvedValue(undefined),
  };
}

// Helper: wait for debounce + chokidar propagation
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("VaultWatcher", () => {
  let tmpDir: string;
  let mockSync: ReturnType<typeof createMockVaultSync>;
  let watcher: VaultWatcher;

  const DEBOUNCE = 100;
  const RENAME_WINDOW = 250;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "vaultwatcher-"));
    mockSync = createMockVaultSync();
  });

  afterEach(async () => {
    await watcher?.stop();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function startWatcher() {
    watcher = createVaultWatcher({
      vaultPath: tmpDir,
      vaultSync: mockSync as unknown as VaultSync,
      debounceMs: DEBOUNCE,
      renameWindowMs: RENAME_WINDOW,
      chokidarOptions: { usePolling: true, interval: 50 },
    });
    watcher.start();
    await watcher.ready;
  }

  async function waitFor(fn: () => void, timeout = 3000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      try {
        fn();
        return;
      } catch {
        await wait(50);
      }
    }
    fn(); // final attempt — throws on failure
  }

  async function writeFile(relPath: string, content: string) {
    const abs = path.join(tmpDir, relPath);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, content, "utf-8");
  }

  it("calls handleUpsert on file create", async () => {
    await startWatcher();
    await writeFile("test.md", "# Hello");
    await waitFor(() => expect(mockSync.handleUpsert).toHaveBeenCalledWith("test.md"));
  });

  it("calls handleUpsert on file change", async () => {
    await writeFile("existing.md", "original");
    await startWatcher();

    await writeFile("existing.md", "modified");
    await waitFor(() => expect(mockSync.handleUpsert).toHaveBeenCalledWith("existing.md"));
  });

  it("calls handleDelete on file unlink", async () => {
    await writeFile("todelete.md", "bye");
    await startWatcher();

    await fs.unlink(path.join(tmpDir, "todelete.md"));
    await waitFor(() => expect(mockSync.handleDelete).toHaveBeenCalledWith("todelete.md"));
  });

  it("honors a configured rename detection window", async () => {
    await writeFile("fast-delete.md", "bye");
    watcher = createVaultWatcher({
      vaultPath: tmpDir,
      vaultSync: mockSync as unknown as VaultSync,
      debounceMs: 1,
      renameWindowMs: 10,
      chokidarOptions: { usePolling: true, interval: 10 },
    });
    watcher.start();
    await watcher.ready;

    await fs.unlink(path.join(tmpDir, "fast-delete.md"));

    await waitFor(() => expect(mockSync.handleDelete).toHaveBeenCalledWith("fast-delete.md"), 500);
  });

  it("debounce coalesces rapid changes", async () => {
    await startWatcher();

    for (let i = 0; i < 5; i++) {
      await writeFile("rapid.md", `content ${i}`);
      await wait(10);
    }

    await waitFor(() => expect(mockSync.handleUpsert).toHaveBeenCalledWith("rapid.md"));
    // Should be called once (debounced), not 5 times
    expect(mockSync.handleUpsert).toHaveBeenCalledTimes(1);
  });

  it("ignores non-markdown files", async () => {
    await startWatcher();

    await writeFile("readme.txt", "text file");
    await writeFile("data.json", "{}");
    await wait(DEBOUNCE + 400);

    expect(mockSync.handleUpsert).not.toHaveBeenCalled();
  });

  it("ignores dot-prefixed directories", async () => {
    await startWatcher();

    await writeFile(".obsidian/workspace.md", "hidden");
    await wait(DEBOUNCE + 400);

    expect(mockSync.handleUpsert).not.toHaveBeenCalled();
  });

  it("stop() removes all listeners", async () => {
    await startWatcher();
    expect(watcher.isRunning).toBe(true);

    await watcher.stop();
    expect(watcher.isRunning).toBe(false);

    await writeFile("after-stop.md", "should be ignored");
    await wait(DEBOUNCE + 400);

    expect(mockSync.handleUpsert).not.toHaveBeenCalled();
  });

  it("debounced callbacks do not fire after stop()", async () => {
    await startWatcher();

    // Trigger a file create (starts debounce timer)
    await writeFile("pre-stop.md", "content");
    // Stop immediately before debounce fires
    await watcher.stop();
    await wait(DEBOUNCE + 400);

    expect(mockSync.handleUpsert).not.toHaveBeenCalled();
  });

  it("stop() before start() does not crash", async () => {
    watcher = createVaultWatcher({
      vaultPath: tmpDir,
      vaultSync: mockSync as unknown as VaultSync,
      debounceMs: DEBOUNCE,
    });
    // stop() before start() should be a no-op
    await expect(watcher.stop()).resolves.toBeUndefined();
    expect(watcher.isRunning).toBe(false);
  });

  it("tracks eventsProcessed counter after upsert", async () => {
    await startWatcher();
    await writeFile("counted.md", "# Test");
    await waitFor(() => expect(mockSync.handleUpsert).toHaveBeenCalledWith("counted.md"));
    // Allow the .then() to run
    await wait(50);
    expect(watcher.stats.eventsProcessed).toBe(1);
    expect(watcher.stats.errors).toBe(0);
  });

  it("increments error counter when handleUpsert rejects", async () => {
    mockSync.handleUpsert.mockRejectedValueOnce(new Error("sync fail"));
    await startWatcher();
    await writeFile("fail.md", "content");
    await waitFor(() => expect(watcher.stats.errors).toBeGreaterThan(0));
  });

  it("calls handleDelete on file unlink after rename window", async () => {
    await writeFile("standalone.md", "content");
    await startWatcher();

    await fs.unlink(path.join(tmpDir, "standalone.md"));
    await wait(RENAME_WINDOW + DEBOUNCE + 200);
    expect(mockSync.handleDelete).toHaveBeenCalledWith("standalone.md");
    expect(mockSync.handleRename).not.toHaveBeenCalled();
  });

  it("increments error counter when handleDelete throws", async () => {
    mockSync.handleDelete.mockImplementationOnce(() => {
      throw new Error("delete fail");
    });
    await writeFile("del-err.md", "content");
    await startWatcher();

    await fs.unlink(path.join(tmpDir, "del-err.md"));
    await wait(RENAME_WINDOW + DEBOUNCE + 200);
    expect(watcher.stats.errors).toBeGreaterThan(0);
    expect(mockSync.handleRename).not.toHaveBeenCalled();
  });

  it("stop() clears both debounce and pending-unlink timers before they fire", async () => {
    await writeFile("pending.md", "content");
    await startWatcher();

    await fs.unlink(path.join(tmpDir, "pending.md"));
    // Stop immediately — timers should be cleared, no delete/rename should fire
    await watcher.stop();
    await wait(300);

    expect(mockSync.handleDelete).not.toHaveBeenCalled();
    expect(mockSync.handleRename).not.toHaveBeenCalled();
  });

  it("start() is idempotent — calling it twice does not create duplicate listeners", async () => {
    watcher = createVaultWatcher({
      vaultPath: tmpDir,
      vaultSync: mockSync as unknown as VaultSync,
      debounceMs: DEBOUNCE,
      chokidarOptions: { usePolling: true, interval: 50 },
    });
    watcher.start();
    watcher.start(); // second call should be a no-op
    await watcher.ready;

    await writeFile("once.md", "content");
    await waitFor(() => expect(mockSync.handleUpsert).toHaveBeenCalled());
    // Expect exactly one call despite double start()
    expect(mockSync.handleUpsert).toHaveBeenCalledTimes(1);
  });

  it("rename detection: calls handleRename(old, new) when unlink is followed by add within window", async () => {
    await writeFile("a.md", "# A");
    await startWatcher();

    // Simulate rename: unlink a.md first, wait for chokidar to detect it, then add b.md within the rename window
    await fs.unlink(path.join(tmpDir, "a.md"));
    // Wait 3+ polling cycles to ensure unlink event is processed before add
    await wait(160);
    await writeFile("b.md", "# B");

    await waitFor(() => expect(mockSync.handleRename).toHaveBeenCalledWith("a.md", "b.md"), 3000);
    expect(mockSync.handleDelete).not.toHaveBeenCalled();
    expect(watcher.stats.eventsProcessed).toBeGreaterThanOrEqual(1);
  });
});
