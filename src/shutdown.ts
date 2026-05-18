import type { logger as rootLogger } from "./utils/logger.js";

type Logger = Pick<typeof rootLogger, "error">;

export interface ShutdownOptions {
  cleanup(): Promise<void>;
  exit(code: number): never;
  logger?: Logger;
  timeoutMs?: number;
}

export function createShutdown({ cleanup, exit, logger, timeoutMs = 10_000 }: ShutdownOptions): () => Promise<void> {
  let shuttingDown = false;

  return async () => {
    if (shuttingDown) return;
    shuttingDown = true;

    const forceExit = setTimeout(() => {
      logger?.error("index", "shutdown timed out, forcing exit");
      exit(1);
    }, timeoutMs);
    forceExit.unref();

    try {
      await cleanup();
    } catch (err) {
      logger?.error("index", "error during shutdown cleanup", {
        stack: err instanceof Error ? (err.stack ?? err.message) : String(err),
      });
    }
    clearTimeout(forceExit);
    exit(0);
  };
}
