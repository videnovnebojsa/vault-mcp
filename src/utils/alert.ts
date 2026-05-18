/**
 * Lightweight outbound webhook for local service alerts.
 * Posts JSON to ALERT_WEBHOOK_URL when critical events occur
 * (backup failures, watcher errors, etc.).
 *
 * Does not throw — fire-and-forget with structured logger output on failure.
 */
import { logger } from "./logger.js";

export async function sendAlert(opts: {
  webhookUrl: string;
  level: "info" | "warn" | "error";
  source: string;
  message: string;
  details?: Record<string, unknown>;
}): Promise<void> {
  // Mask credentials in URL before logging (e.g. http://user:password@host)
  const maskedUrl = opts.webhookUrl.replace(/:[^:@/]+@/, ":***@");

  try {
    const response = await fetch(opts.webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        level: opts.level,
        source: opts.source,
        message: opts.message,
        details: opts.details,
        timestamp: new Date().toISOString(),
        service: "vault-mcp",
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      logger.warn("alert", "webhook returned error", {
        status: response.status,
        url: maskedUrl,
        source: opts.source,
      });
    }
  } catch (err) {
    logger.warn("alert", "failed to send alert", {
      err: err instanceof Error ? err.message : String(err),
      source: opts.source,
      level: opts.level,
      url: maskedUrl,
    });
  }
}
