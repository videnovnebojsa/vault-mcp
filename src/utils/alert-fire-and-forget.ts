import { sendAlert } from "./alert.js";
import { logger } from "./logger.js";

export function sendAlertFireAndForget(opts: Parameters<typeof sendAlert>[0]): void {
  Promise.resolve(sendAlert(opts)).catch((err: unknown) => {
    logger.warn("alert", "fire-and-forget alert failed", {
      err: err instanceof Error ? err.message : String(err),
      source: opts.source,
      level: opts.level,
    });
  });
}
