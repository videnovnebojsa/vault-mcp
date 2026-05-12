const LEVELS = { debug: 0, info: 1, warn: 2, error: 3 } as const;
type LogLevel = keyof typeof LEVELS;

// Cache config at module load (avoids re-reading env vars per log call)
const cachedLevel: LogLevel = (() => {
  const env = (process.env["LOG_LEVEL"] ?? "info").toLowerCase();
  return env in LEVELS ? (env as LogLevel) : "info";
})();
const cachedJson: boolean = process.env["LOG_FORMAT"] === "json";

export interface ChildLogger {
  debug(message: string, extra?: Record<string, unknown>): void;
  info(message: string, extra?: Record<string, unknown>): void;
  warn(message: string, extra?: Record<string, unknown>): void;
  error(message: string, extra?: Record<string, unknown>): void;
}

function emit(level: LogLevel, tag: string, message: string, extra?: Record<string, unknown>): void {
  if (LEVELS[level] < LEVELS[cachedLevel]) return;

  if (cachedJson) {
    const entry: Record<string, unknown> = { level, tag, message, ts: new Date().toISOString() };
    if (extra) Object.assign(entry, extra);
    console.error(JSON.stringify(entry));
  } else {
    const prefix = `[${tag}]`;
    if (extra) {
      console.error(prefix, message, extra);
    } else {
      console.error(prefix, message);
    }
  }
}

export const logger = {
  debug: (tag: string, message: string, extra?: Record<string, unknown>) => emit("debug", tag, message, extra),
  info: (tag: string, message: string, extra?: Record<string, unknown>) => emit("info", tag, message, extra),
  warn: (tag: string, message: string, extra?: Record<string, unknown>) => emit("warn", tag, message, extra),
  error: (tag: string, message: string, extra?: Record<string, unknown>) => emit("error", tag, message, extra),
  child(tag: string): ChildLogger {
    return {
      debug: (message: string, extra?: Record<string, unknown>) => emit("debug", tag, message, extra),
      info: (message: string, extra?: Record<string, unknown>) => emit("info", tag, message, extra),
      warn: (message: string, extra?: Record<string, unknown>) => emit("warn", tag, message, extra),
      error: (message: string, extra?: Record<string, unknown>) => emit("error", tag, message, extra),
    };
  },
};
