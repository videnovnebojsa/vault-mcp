/**
 * Lightweight outbound webhook for local service alerts.
 * Posts JSON to ALERT_WEBHOOK_URL when critical events occur
 * (backup failures, watcher errors, etc.).
 *
 * Does not throw — fire-and-forget with stderr logging on failure.
 */
export async function sendAlert(opts: {
  webhookUrl: string;
  level: "info" | "warn" | "error";
  source: string;
  message: string;
  details?: Record<string, unknown>;
}): Promise<void> {
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
        service: "vault-service",
      }),
      signal: AbortSignal.timeout(5000),
    });

    if (!response.ok) {
      console.error(`[alert] Webhook returned ${response.status}: ${await response.text().catch(() => "")}`);
    }
  } catch (err) {
    console.error(`[alert] Failed to send alert:`, err instanceof Error ? err.message : err);
  }
}
