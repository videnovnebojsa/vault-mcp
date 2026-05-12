import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendAlert } from "./alert.js";

describe("sendAlert", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn().mockResolvedValue({ ok: true, text: () => Promise.resolve("") });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("sends POST with correct payload", async () => {
    await sendAlert({
      webhookUrl: "http://example.com/alert",
      level: "error",
      source: "scheduler",
      message: "Backup failed",
      details: { taskId: "db-backup" },
    });

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "http://example.com/alert",
      expect.objectContaining({
        method: "POST",
        headers: { "Content-Type": "application/json" },
      }),
    );

    const body = JSON.parse(vi.mocked(globalThis.fetch).mock.calls[0]?.[1]?.body as string);
    expect(body.level).toBe("error");
    expect(body.source).toBe("scheduler");
    expect(body.message).toBe("Backup failed");
    expect(body.details).toEqual({ taskId: "db-backup" });
    expect(body.service).toBe("vault-service");
    expect(body.timestamp).toBeDefined();
  });

  it("does not throw on fetch failure", async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error("network error"));

    await expect(
      sendAlert({
        webhookUrl: "http://unreachable.example.com/alert",
        level: "error",
        source: "test",
        message: "test",
      }),
    ).resolves.toBeUndefined();
  });

  it("does not throw on non-ok response", async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve("Internal Server Error"),
    });

    await expect(
      sendAlert({
        webhookUrl: "http://example.com/alert",
        level: "warn",
        source: "test",
        message: "test",
      }),
    ).resolves.toBeUndefined();
  });
});
