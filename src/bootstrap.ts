import fs from "node:fs/promises";
import { loadConfig, type VaultConfig } from "./config.js";
import { initOtel } from "./utils/otel.js";
import { VaultManager } from "./vault/manager.js";

export interface BootstrapResult {
  config: VaultConfig;
  vaultManager: VaultManager;
}

export async function bootstrap(): Promise<BootstrapResult> {
  const config = loadConfig();

  try {
    const stat = await fs.stat(config.vaultPath);
    if (!stat.isDirectory()) {
      throw new Error(`OBSIDIAN_VAULT_PATH is not a directory: ${config.vaultPath}`);
    }
  } catch (err) {
    if (err instanceof Error && err.message.startsWith("OBSIDIAN_VAULT_PATH")) throw err;
    throw new Error(`Vault path does not exist: ${config.vaultPath}`);
  }

  for (const [name, vaultPath] of Object.entries(config.namedVaults)) {
    if (name === "default") continue;
    try {
      const stat = await fs.stat(vaultPath);
      if (!stat.isDirectory()) {
        throw new Error(`VAULT_PATHS entry "${name}" is not a directory: ${vaultPath}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("VAULT_PATHS")) throw err;
      throw new Error(`VAULT_PATHS entry "${name}" does not exist: ${vaultPath}`);
    }
  }

  if (config.embedding.enabled && !config.embedding.apiKey) {
    console.error("[config] Warning: ENABLE_EMBEDDINGS=true but EMBEDDING_API_KEY is not set");
  }

  if (config.enableOtel) {
    initOtel(config.otelEndpoint);
  }

  const vaultManager = new VaultManager(config.namedVaults, config);

  return { config, vaultManager };
}
