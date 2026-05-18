declare const sqliteStringLiteralBrand: unique symbol;

export type SqliteStringLiteral = string & { readonly [sqliteStringLiteralBrand]: true };

export function sqliteStringLiteral(source: string): SqliteStringLiteral {
  if (!/^'(?:[^']|'')*'$/.test(source)) {
    throw new Error("Expected SQLite quote() string literal");
  }
  return source as SqliteStringLiteral;
}

export function vacuumIntoSql(quotedDestPath: SqliteStringLiteral): string {
  return `VACUUM INTO ${quotedDestPath}`;
}

const READ_PRAGMAS = new Set(["journal_mode", "schema_version", "user_version"]);
const WRITE_PRAGMAS = new Map<string, Set<string>>([
  ["journal_mode", new Set(["wal", "delete", "truncate", "persist", "memory", "off"])],
]);
const EXPENSIVE_PRAGMAS = new Set(["integrity_check", "quick_check", "optimize", "analysis_limit"]);

export function pragmaSql(source: string): string {
  const match = source.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\s*=\s*([A-Za-z0-9_-]+))?$/);
  if (!match) throw new Error("Unsupported SQLite PRAGMA");

  const [, rawName, value] = match;
  if (!rawName) throw new Error("Unsupported SQLite PRAGMA");

  const name = rawName.toLowerCase();
  if (EXPENSIVE_PRAGMAS.has(name)) throw new Error("Expensive SQLite PRAGMA");
  if (value === undefined) {
    if (!READ_PRAGMAS.has(name)) throw new Error("Unsupported SQLite PRAGMA");
    return `PRAGMA ${name}`;
  }

  const allowedValues = WRITE_PRAGMAS.get(name);
  if (!allowedValues?.has(value.toLowerCase())) throw new Error("Unsupported SQLite PRAGMA");
  return `PRAGMA ${name} = ${value.toUpperCase()}`;
}
