export {};

if (process.argv[2] === "bridge") {
  await import("./bridge-main.js");
} else {
  const { bootstrap } = await import("./bootstrap.js");
  const { startHttpServer } = await import("./http.js");
  const { createShutdown } = await import("./shutdown.js");
  const { logger } = await import("./utils/logger.js");
  const { shutdownOtel } = await import("./utils/otel.js");

  const boot = await bootstrap().catch((err) => {
    logger.error("index", "bootstrap failed", {
      stack: err instanceof Error ? (err.stack ?? err.message) : String(err),
    });
    process.exit(1);
  });

  let httpHandle: Awaited<ReturnType<typeof startHttpServer>>;
  try {
    httpHandle = await startHttpServer(boot);
  } catch (err) {
    logger.error("index", "http server failed to start", {
      stack: err instanceof Error ? (err.stack ?? err.message) : String(err),
    });
    process.exit(1);
  }

  const shutdown = createShutdown({
    logger,
    exit: (code) => process.exit(code),
    cleanup: async () => {
      await httpHandle.close();
      await boot.vaultManager.shutdown();
      await shutdownOtel().catch((e) =>
        logger.warn("index", "otel flush error", { err: e instanceof Error ? e.message : String(e) }),
      );
    },
  });

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  process.on("unhandledRejection", (reason) => {
    const stack = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    logger.error("index", "unhandledRejection", { stack });
    void shutdown();
  });

  process.on("uncaughtException", (err) => {
    logger.error("index", "uncaughtException", { stack: err.stack ?? err.message });
    process.exit(1);
  });
}
