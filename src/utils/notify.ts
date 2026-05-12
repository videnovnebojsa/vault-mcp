import { getCircuit } from "./circuits.js";
import { logger } from "./logger.js";

export interface TelegramNotifyConfig {
  botToken: string;
  chatId: string;
}

/**
 * Load Telegram config from environment variables.
 * Returns undefined if not configured.
 */
export function loadTelegramConfig(): TelegramNotifyConfig | undefined {
  const botToken = process.env["TELEGRAM_BOT_TOKEN"];
  const chatId = process.env["TELEGRAM_CHAT_ID"];
  if (!botToken || !chatId) return undefined;
  return { botToken, chatId };
}

/**
 * Send a Telegram message via Bot API.
 * Returns true on success, false on failure (never throws).
 * Protected by a circuit breaker to avoid slow timeouts when Telegram is unreachable.
 */
export async function sendTelegramNotification(config: TelegramNotifyConfig, message: string): Promise<boolean> {
  const url = `https://api.telegram.org/bot${config.botToken}/sendMessage`;
  const circuit = getCircuit("telegram");

  try {
    const ok = await circuit.execute(async () => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: config.chatId, text: message }),
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`Telegram API error: ${res.status}`);
      return true;
    });
    return ok;
  } catch (err) {
    logger.warn("notify", "Telegram notification failed", { err: err instanceof Error ? err.message : String(err) });
    return false;
  }
}

/**
 * Format a scheduler task result for Telegram notification.
 * Uses plain text (no Markdown) to avoid parse failures from special chars in error messages.
 */
export function formatSchedulerResult(taskId: string, ok: boolean, message: string, durationMs: number): string {
  const icon = ok ? "\u2705" : "\u274C";
  const status = ok ? "OK" : "FAIL";
  const duration = (durationMs / 1000).toFixed(1);
  return `${icon} vault-service | ${taskId}: ${status}\n${message}\n${duration}s`;
}
