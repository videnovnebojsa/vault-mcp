import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";

// ── Module mocks ──────────────────────────────────────────────────────────────

mock.module("node:fs/promises", () => ({
  default: { stat: mock() },
  stat: mock(),
}));

mock.module("./config.js", () => ({
  loadConfig: mock(),
}));

mock.module("./utils/otel.js", () => ({
  initOtel: mock(),
}));

mock.module("./utils/alert.js", () => ({
  sendAlert: mock(),
}));

mock.module("./vault/manager.js", () => ({
  VaultManager: mock(),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import fs from "node:fs/promises";
import { bootstrap } from "./bootstrap.js";
import { loadConfig } from "./config.js";
import { sendAlert } from "./utils/alert.js";
import { initOtel } from "./utils/otel.js";
import { VaultManager } from "./vault/manager.js";

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    vaultPath: "/vault/default",
    namedVaults: { default: "/vault/default" },
    embedding: { enabled: false, apiKey: "" },
    watcher: { enabled: false, debounceMs: 300 },
    enableOtel: false,
    otelEndpoint: "",
    mcpHost: "127.0.0.1",
    mcpApiKey: "",
    ...overrides,
  };
}

const mockStat = fs.stat as ReturnType<typeof mock>;
const mockLoadConfig = loadConfig as ReturnType<typeof mock>;
const mockSendAlert = sendAlert as ReturnType<typeof mock>;
const mockInitOtel = initOtel as ReturnType<typeof mock>;
const MockVaultManager = VaultManager as ReturnType<typeof mock>;

const mockSvc = {
  vault: {},
  capture: null,
  searchStore: {},
  vaultSync: {},
  watcher: null,
  embeddingStore: undefined,
  embedProvider: undefined,
  embeddingConfig: { enabled: false },
  aclConfig: { allowPaths: [], denyPaths: [] },
  vaultPath: "/vault",
  bootFailed: false,
  bootReady: Promise.resolve(),
};

beforeEach(() => {
  mock.restore();
  mockStat.mockClear();
  mockLoadConfig.mockClear();
  mockSendAlert.mockClear();
  mockInitOtel.mockClear();
  MockVaultManager.mockClear();
  mockLoadConfig.mockReturnValue(makeConfig());
  mockStat.mockResolvedValue({ isDirectory: () => true });
  MockVaultManager.mockImplementation(() => ({
    getServices: mock().mockReturnValue(mockSvc),
  }));
});

afterEach(() => {
  mock.restore();
});

// ── Happy path ────────────────────────────────────────────────────────────────

describe("bootstrap happy path", () => {
  it("returns a BootstrapResult with vaultManager and config", async () => {
    const result = await bootstrap();
    expect(result.vaultManager).toBeDefined();
    expect(result.config).toBeDefined();
  });

  it("does not throw when single default vault is valid", async () => {
    await expect(bootstrap()).resolves.toBeDefined();
  });

  it("validates named vaults beyond default", async () => {
    mockLoadConfig.mockReturnValue(makeConfig({ namedVaults: { default: "/vault/default", work: "/vault/work" } }));
    // stat is called for both default and work vaults
    await expect(bootstrap()).resolves.toBeDefined();
    expect(mockStat).toHaveBeenCalledTimes(2);
  });

  it("skips stat check for default key in namedVaults loop", async () => {
    // The default vault is only checked once (via the dedicated vaultPath check, not the loop)
    await bootstrap();
    // stat called once for vaultPath, zero more times (default is skipped in the loop)
    expect(mockStat).toHaveBeenCalledTimes(1);
    expect(mockStat).toHaveBeenCalledWith("/vault/default");
  });
});

// ── Vault path validation ─────────────────────────────────────────────────────

describe("bootstrap vault path validation", () => {
  it("throws when vault path does not exist", async () => {
    mockStat.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    await expect(bootstrap()).rejects.toThrow("Vault path does not exist");
  });

  it("sends an alert when boot validation fails and webhook is configured", async () => {
    mockLoadConfig.mockReturnValue(makeConfig({ alertWebhookUrl: "http://alerts.example.test/hook" }));
    mockStat.mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));

    await expect(bootstrap()).rejects.toThrow("Vault path does not exist");

    expect(mockSendAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        webhookUrl: "http://alerts.example.test/hook",
        level: "error",
        source: "bootstrap",
      }),
    );
  });

  it("throws 'does not exist' for non-ENOENT stat failures (e.g. EACCES)", async () => {
    mockStat.mockRejectedValueOnce(Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" }));
    await expect(bootstrap()).rejects.toThrow("Vault path does not exist");
  });

  it("throws when vault path is a file, not a directory", async () => {
    mockStat.mockResolvedValueOnce({ isDirectory: () => false });
    await expect(bootstrap()).rejects.toThrow("is not a directory");
  });

  it("throws when a named vault path does not exist", async () => {
    mockLoadConfig.mockReturnValue(makeConfig({ namedVaults: { default: "/vault/default", work: "/vault/work" } }));
    // First stat (default vault) succeeds; second (work vault) fails
    mockStat
      .mockResolvedValueOnce({ isDirectory: () => true })
      .mockRejectedValueOnce(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    await expect(bootstrap()).rejects.toThrow('VAULT_PATHS entry "work" does not exist');
  });

  it("throws when a named vault path is a file", async () => {
    mockLoadConfig.mockReturnValue(makeConfig({ namedVaults: { default: "/vault/default", work: "/vault/work" } }));
    mockStat.mockResolvedValueOnce({ isDirectory: () => true }).mockResolvedValueOnce({ isDirectory: () => false });
    await expect(bootstrap()).rejects.toThrow('VAULT_PATHS entry "work" is not a directory');
  });
});

// ── Embedding warning ─────────────────────────────────────────────────────────

describe("bootstrap embedding config warning", () => {
  it("logs a warning when embeddings enabled but API key is missing", async () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    mockLoadConfig.mockReturnValue(makeConfig({ embedding: { enabled: true, apiKey: "" } }));
    await bootstrap();
    // logger.warn calls console.error with (prefix, message) args
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining("[bootstrap]"),
      expect.stringContaining("EMBEDDING_API_KEY"),
    );
    spy.mockRestore();
  });

  it("does not warn when embeddings enabled and API key is set", async () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    mockLoadConfig.mockReturnValue(makeConfig({ embedding: { enabled: true, apiKey: "sk-test-123" } }));
    await bootstrap();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("does not warn when embeddings are disabled", async () => {
    const spy = spyOn(console, "error").mockImplementation(() => {});
    mockLoadConfig.mockReturnValue(makeConfig({ embedding: { enabled: false, apiKey: "" } }));
    await bootstrap();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});

// ── OTel initialization ───────────────────────────────────────────────────────

describe("bootstrap OTel initialization", () => {
  it("calls initOtel when enableOtel is true", async () => {
    mockLoadConfig.mockReturnValue(makeConfig({ enableOtel: true, otelEndpoint: "http://otel:4318" }));
    await bootstrap();
    expect(mockInitOtel).toHaveBeenCalledWith("http://otel:4318");
  });

  it("does not call initOtel when enableOtel is false", async () => {
    mockLoadConfig.mockReturnValue(makeConfig({ enableOtel: false }));
    await bootstrap();
    expect(mockInitOtel).not.toHaveBeenCalled();
  });
});
