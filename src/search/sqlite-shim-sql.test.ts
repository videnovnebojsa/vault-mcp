import { describe, expect, it } from "bun:test";
import { pragmaSql, sqliteStringLiteral, vacuumIntoSql } from "./sqlite-shim-sql.js";

describe("sqlite shim backup SQL", () => {
  it("builds VACUUM INTO SQL for a normal destination path [QA-01]", () => {
    expect(vacuumIntoSql(sqliteStringLiteral("'/tmp/vault-backup.db'"))).toBe("VACUUM INTO '/tmp/vault-backup.db'");
  });

  it("escapes single quotes in destination paths [QA-01]", () => {
    expect(vacuumIntoSql(sqliteStringLiteral("'/tmp/vault''s backup.db'"))).toBe(
      "VACUUM INTO '/tmp/vault''s backup.db'",
    );
  });

  it("requires callers to pass a SQLite-quoted string literal [SEC-01]", () => {
    expect(() => sqliteStringLiteral("/tmp/vault-backup.db")).toThrow("Expected SQLite quote() string literal");
  });
});

describe("sqlite shim PRAGMA SQL", () => {
  it("rejects dangerous PRAGMA passthrough [SEC-03]", () => {
    expect(() => pragmaSql("writable_schema = ON")).toThrow("Unsupported SQLite PRAGMA");
  });

  it("allows documented startup PRAGMAs and rejects arbitrary PRAGMAs [QA-04]", () => {
    expect(pragmaSql("journal_mode = WAL")).toBe("PRAGMA journal_mode = WAL");
    expect(() => pragmaSql("cache_size = 2000")).toThrow("Unsupported SQLite PRAGMA");
  });

  it("generates read-only PRAGMA SQL for schema_version and user_version [QA-04]", () => {
    expect(pragmaSql("schema_version")).toBe("PRAGMA schema_version");
    expect(pragmaSql("user_version")).toBe("PRAGMA user_version");
  });

  it("rejects write form of read-only PRAGMAs [QA-04]", () => {
    expect(() => pragmaSql("schema_version = 5")).toThrow("Unsupported SQLite PRAGMA");
    expect(() => pragmaSql("user_version = 5")).toThrow("Unsupported SQLite PRAGMA");
  });

  it("rejects accidentally expensive PRAGMAs with an explicit error [PERF-02]", () => {
    expect(() => pragmaSql("integrity_check")).toThrow("Expensive SQLite PRAGMA");
    expect(() => pragmaSql("optimize")).toThrow("Expensive SQLite PRAGMA");
  });

  it("allows busy_timeout with an integer value [DB-01]", () => {
    expect(pragmaSql("busy_timeout = 5000")).toBe("PRAGMA busy_timeout = 5000");
    expect(pragmaSql("busy_timeout = 0")).toBe("PRAGMA busy_timeout = 0");
    expect(pragmaSql("busy_timeout")).toBe("PRAGMA busy_timeout");
  });

  it("rejects non-integer and out-of-range busy_timeout values [DB-01]", () => {
    expect(() => pragmaSql("busy_timeout = -1")).toThrow("Unsupported SQLite PRAGMA");
    expect(() => pragmaSql("busy_timeout = 5.5")).toThrow("Unsupported SQLite PRAGMA");
    expect(() => pragmaSql("busy_timeout = abc")).toThrow("Unsupported SQLite PRAGMA");
    expect(() => pragmaSql("busy_timeout = 300001")).toThrow("Unsupported SQLite PRAGMA");
  });

  it("does not open the numeric path to other integer PRAGMAs [DB-01]", () => {
    expect(() => pragmaSql("cache_size = 2000")).toThrow("Unsupported SQLite PRAGMA");
    expect(() => pragmaSql("journal_size_limit = 100")).toThrow("Unsupported SQLite PRAGMA");
  });
});
