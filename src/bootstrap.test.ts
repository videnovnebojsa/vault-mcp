import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ── Module mocks ──────────────────────────────────────────────────────────────

vi.mock("node:fs/promises", () => ({
  default: { stat: vi.fn() },
  stat: vi.fn(),
}));

vi.mock("./config.js", () => ({
  loadConfig: vi.fn(),
}));

vi.mock("./utils/otel.js", () => ({
  initOtel: vi.fn(),
}));

vi.mock("./vault/manager.js", () => ({
  VaultManager: vi.fn(),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import fs from "node:fs/promises";
import { bootstrap } from "./bootstrap.js";
import { loadConfig } from "./config.js";
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
    ...overrides,
  };
}

const mockStat = fs.stat as ReturnType<typeof vi.fn>;
const mockLoadConfig = loadConfig as ReturnType<typeof vi.fn>;
const mockInitOtel = initOtel as ReturnType<typeof vi.fn>;
const MockVaultManager = VaultManager as ReturnType<typeof vi.fn>;

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
  vi.clearAllMocks();
  mockLoadConfig.mockReturnValue(makeConfig());
  mockStat.mockResolvedValue({ isDirectory: () => true });
  MockVaultManager.mockImplementation(() => ({
    getServices: vi.fn().mockReturnValue(mockSvc),
  }));
});

afterEach(() => {
  vi.restoreAllMocks();
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
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockLoadConfig.mockReturnValue(makeConfig({ embedding: { enabled: true, apiKey: "" } }));
    await bootstrap();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("EMBEDDING_API_KEY"));
    spy.mockRestore();
  });

  it("does not warn when embeddings enabled and API key is set", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockLoadConfig.mockReturnValue(makeConfig({ embedding: { enabled: true, apiKey: "sk-test-123" } }));
    await bootstrap();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("does not warn when embeddings are disabled", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
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
