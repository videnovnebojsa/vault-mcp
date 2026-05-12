import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAllCircuits } from "./circuits.js";
import { formatSchedulerResult, loadTelegramConfig, sendTelegramNotification } from "./notify.js";

const cfg = { botToken: "bot123", chatId: "chat456" };

describe("sendTelegramNotification", () => {
  beforeEach(() => {
    resetAllCircuits();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    resetAllCircuits();
  });

  it("returns true on successful HTTP 200 response", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const result = await sendTelegramNotification(cfg, "hello");
    expect(result).toBe(true);
    expect(spy).toHaveBeenCalledOnce();
  });

  it("returns false when HTTP response is not ok (4xx/5xx)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("Bad Request", { status: 400 }));
    const result = await sendTelegramNotification(cfg, "hello");
    expect(result).toBe(false);
  });

  it("returns false on network error (never throws)", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new TypeError("fetch failed"));
    const result = await sendTelegramNotification(cfg, "hello");
    expect(result).toBe(false);
  });

  it("opens the circuit after repeated failures and returns false without fetching", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("error", { status: 500 }));

    // Trip the circuit (threshold=3)
    for (let i = 0; i < 3; i++) {
      await sendTelegramNotification(cfg, "ping");
    }

    spy.mockClear();
    const result = await sendTelegramNotification(cfg, "ping");
    expect(result).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("notify", () => {
  describe("formatSchedulerResult", () => {
    it("formats OK result as plain text", () => {
      const msg = formatSchedulerResult("digest-morning", true, "Digest (morning) written", 1234);
      expect(msg).toContain("digest-morning");
      expect(msg).toContain("OK");
      expect(msg).toContain("1.2s");
      expect(msg).toContain("\u2705"); // checkmark
      // No Markdown special chars
      expect(msg).not.toContain("*");
      expect(msg).not.toContain("`");
      expect(msg).not.toContain("_");
    });

    it("formats FAIL result as plain text", () => {
      const msg = formatSchedulerResult("task-sync", false, "API timeout", 500);
      expect(msg).toContain("task-sync");
      expect(msg).toContain("FAIL");
      expect(msg).toContain("0.5s");
      expect(msg).toContain("\u274C"); // cross mark
    });

    it("handles messages with Markdown-like chars safely", () => {
      const msg = formatSchedulerResult("test", false, "Error in /tmp/foo_bar [retry]", 100);
      // Should just include the message verbatim, no escaping needed (plain text)
      expect(msg).toContain("/tmp/foo_bar [retry]");
    });
  });

  describe("loadTelegramConfig", () => {
    it("returns undefined when env vars not set", () => {
      const orig = { token: process.env.TELEGRAM_BOT_TOKEN, chat: process.env.TELEGRAM_CHAT_ID };
      delete process.env.TELEGRAM_BOT_TOKEN;
      delete process.env.TELEGRAM_CHAT_ID;
      expect(loadTelegramConfig()).toBeUndefined();
      // Restore
      if (orig.token) process.env.TELEGRAM_BOT_TOKEN = orig.token;
      if (orig.chat) process.env.TELEGRAM_CHAT_ID = orig.chat;
    });

    it("returns config when both vars set", () => {
      const orig = { token: process.env.TELEGRAM_BOT_TOKEN, chat: process.env.TELEGRAM_CHAT_ID };
      process.env.TELEGRAM_BOT_TOKEN = "123:ABC";
      process.env.TELEGRAM_CHAT_ID = "456";
      const cfg = loadTelegramConfig();
      expect(cfg).toEqual({ botToken: "123:ABC", chatId: "456" });
      // Restore
      if (orig.token) process.env.TELEGRAM_BOT_TOKEN = orig.token;
      else delete process.env.TELEGRAM_BOT_TOKEN;
      if (orig.chat) process.env.TELEGRAM_CHAT_ID = orig.chat;
      else delete process.env.TELEGRAM_CHAT_ID;
    });
  });
});
