import fs from "node:fs/promises";
import { SecondBrainService } from "./capture/service.js";
import { loadConfig, type VaultConfig } from "./config.js";
import { sendAlert } from "./utils/alert.js";
import { configureCircuitBreakerAlerts } from "./utils/circuit-breaker.js";
import { logger } from "./utils/logger.js";
import { initOtel } from "./utils/otel.js";
import { type CaptureFactory, VaultManager } from "./vault/manager.js";

export interface BootstrapResult {
  config: VaultConfig;
  vaultManager: VaultManager;
}

export async function bootstrap(): Promise<BootstrapResult> {
  const config = loadConfig();
  configureCircuitBreakerAlerts(config.alertWebhookUrl);

  try {
    const stat = await fs.stat(config.vaultPath);
    if (!stat.isDirectory()) {
      throw new Error(`OBSIDIAN_VAULT_PATH is not a directory: ${config.vaultPath}`);
    }
  } catch (err) {
    const bootError =
      err instanceof Error && err.message.startsWith("OBSIDIAN_VAULT_PATH")
        ? err
        : new Error(`Vault path does not exist: ${config.vaultPath}`);
    await alertBootFailure(config.alertWebhookUrl, bootError.message, { vault: "default" });
    throw bootError;
  }

  for (const [name, vaultPath] of Object.entries(config.namedVaults)) {
    if (name === "default") continue;
    try {
      const stat = await fs.stat(vaultPath);
      if (!stat.isDirectory()) {
        throw new Error(`VAULT_PATHS entry "${name}" is not a directory: ${vaultPath}`);
      }
    } catch (err) {
      const bootError =
        err instanceof Error && err.message.startsWith("VAULT_PATHS")
          ? err
          : new Error(`VAULT_PATHS entry "${name}" does not exist: ${vaultPath}`);
      await alertBootFailure(config.alertWebhookUrl, bootError.message, { vault: name });
      throw bootError;
    }
  }

  if (config.embedding.enabled && !config.embedding.apiKey) {
    logger.warn("bootstrap", "ENABLE_EMBEDDINGS=true but EMBEDDING_API_KEY is not set");
  }

  const loopbackHosts = ["127.0.0.1", "::1", "localhost"];
  if (!config.mcpApiKey && !loopbackHosts.includes(config.mcpHost)) {
    logger.warn("bootstrap", "MCP_API_KEY is not set; vault is unauthenticated on non-loopback interface", {
      host: config.mcpHost,
    });
  }

  if (config.enableOtel) {
    initOtel(config.otelEndpoint);
  }

  const createCaptureService: CaptureFactory = ({ vaultPath, config: captureConfig, vault }) =>
    new SecondBrainService({ vaultPath, ...captureConfig, folders: config.folders }, vault);
  const vaultManager = new VaultManager(config.namedVaults, config, undefined, createCaptureService);

  return { config, vaultManager };
}

async function alertBootFailure(webhookUrl: string, message: string, details: Record<string, unknown>): Promise<void> {
  if (!webhookUrl) return;
  await sendAlert({
    webhookUrl,
    level: "error",
    source: "bootstrap",
    message,
    details,
  });
}
