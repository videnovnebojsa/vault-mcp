import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { sendAlert } from "./alert.js";
import { logger } from "./logger.js";

describe("sendAlert", () => {
  const originalFetch = globalThis.fetch;
  let mockWarn: ReturnType<typeof spyOn>;

  beforeEach(() => {
    globalThis.fetch = mock().mockResolvedValue({ ok: true, text: () => Promise.resolve("") });
    mockWarn = spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    mock.restore();
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

    const fetchMock = globalThis.fetch as ReturnType<typeof mock>;
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string);
    expect(body.level).toBe("error");
    expect(body.source).toBe("scheduler");
    expect(body.message).toBe("Backup failed");
    expect(body.details).toEqual({ taskId: "db-backup" });
    expect(body.service).toBe("vault-mcp");
    expect(body.timestamp).toBeDefined();
  });

  it("does not throw on fetch failure", async () => {
    (globalThis.fetch as ReturnType<typeof mock>).mockRejectedValue(new Error("network error"));

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
    (globalThis.fetch as ReturnType<typeof mock>).mockResolvedValue({
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

  it("calls logger.warn (not console.error) when webhook fails", async () => {
    (globalThis.fetch as ReturnType<typeof mock>).mockRejectedValue(new Error("network error"));
    const consoleSpy = spyOn(console, "error").mockImplementation(() => {});

    await sendAlert({
      webhookUrl: "http://unreachable.example.com/alert",
      level: "error",
      source: "test",
      message: "test",
    });

    expect(mockWarn).toHaveBeenCalled();
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("calls logger.warn (not console.error) when webhook returns non-ok status", async () => {
    (globalThis.fetch as ReturnType<typeof mock>).mockResolvedValue({
      ok: false,
      status: 503,
      text: () => Promise.resolve("Service Unavailable"),
    });
    const consoleSpy = spyOn(console, "error").mockImplementation(() => {});

    await sendAlert({
      webhookUrl: "http://example.com/alert",
      level: "error",
      source: "test",
      message: "test",
    });

    expect(mockWarn).toHaveBeenCalled();
    expect(consoleSpy).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });

  it("masks credentials in URL before logging", async () => {
    (globalThis.fetch as ReturnType<typeof mock>).mockRejectedValue(new Error("connection refused"));

    await sendAlert({
      webhookUrl: "http://user:secret-password@example.com/alert",
      level: "error",
      source: "test",
      message: "test",
    });

    expect(mockWarn).toHaveBeenCalled();
    const callArgs = mockWarn.mock.calls[mockWarn.mock.calls.length - 1];
    const loggedData = JSON.stringify(callArgs);
    expect(loggedData).not.toContain("secret-password");
    expect(loggedData).toContain("***");
  });
});
