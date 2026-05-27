import { logger } from "../utils/logger.js";

/** Vault folder taxonomy. Override by passing custom classifyRules to VaultConfig. */
export const VAULT_FOLDERS = {
  INBOX: "00_Inbox",
  PROJECTS: "10_Projects",
  ZETTELKASTEN: "30_Zettelkasten",
  ARTEFACTS: "35_Artefacts",
  CANVASES: "36_Canvases",
  TEMPLATES: "50_Templates",
  AI_LOGS: "70_AI_Logs",
  PEOPLE: "80_People",
  ADMIN: "90_Admin",
  ARCHIVE: "99_Archive",
} as const;

/** Mutable version of the vault folder map — used for runtime-configurable overrides. */
export type VaultFolders = {
  INBOX: string;
  PROJECTS: string;
  ZETTELKASTEN: string;
  ARTEFACTS: string;
  CANVASES: string;
  TEMPLATES: string;
  AI_LOGS: string;
  PEOPLE: string;
  ADMIN: string;
  ARCHIVE: string;
};

/**
 * Validate a single `VAULT_FOLDER_*` env var value. Returns the trimmed value
 * on success. Throws an informative Error if the value is blank, contains path
 * separators (`/`, `\`), or contains null bytes — all of which would produce
 * opaque runtime failures deep in the FS layer.
 */
function resolveFolder(envKey: string, defaultValue: string): string {
  const raw = process.env[envKey];
  if (raw === undefined) return defaultValue;
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error(
      `${envKey} is set but blank. Either provide a non-empty folder name or unset the variable to use the default ("${defaultValue}").`,
    );
  }
  if (trimmed === "." || trimmed === "..") {
    throw new Error(
      `${envKey}="${trimmed}" is a relative path component. Folder names must be a concrete single-component name (not "." or "..").`,
    );
  }
  if (/[/\\\0]/.test(trimmed)) {
    throw new Error(
      `${envKey}="${trimmed}" contains a path separator or null byte. Folder names must be a single path component (no "/" or "\\").`,
    );
  }
  return trimmed;
}

/**
 * Resolve vault folder names from `VAULT_FOLDER_*` env vars, falling back to
 * `VAULT_FOLDERS` defaults. Returns a plain object so callers can pass it
 * around without the `as const` constraint.
 *
 * Throws an Error at startup if any env var is blank or contains path
 * separators — fail-fast rather than silently producing broken paths at
 * write-time.
 */
export function resolveVaultFolders(): VaultFolders {
  const resolved: VaultFolders = {
    INBOX: resolveFolder("VAULT_FOLDER_INBOX", VAULT_FOLDERS.INBOX),
    PROJECTS: resolveFolder("VAULT_FOLDER_PROJECTS", VAULT_FOLDERS.PROJECTS),
    ZETTELKASTEN: resolveFolder("VAULT_FOLDER_ZETTELKASTEN", VAULT_FOLDERS.ZETTELKASTEN),
    ARTEFACTS: resolveFolder("VAULT_FOLDER_ARTEFACTS", VAULT_FOLDERS.ARTEFACTS),
    CANVASES: resolveFolder("VAULT_FOLDER_CANVASES", VAULT_FOLDERS.CANVASES),
    TEMPLATES: resolveFolder("VAULT_FOLDER_TEMPLATES", VAULT_FOLDERS.TEMPLATES),
    AI_LOGS: resolveFolder("VAULT_FOLDER_AI_LOGS", VAULT_FOLDERS.AI_LOGS),
    PEOPLE: resolveFolder("VAULT_FOLDER_PEOPLE", VAULT_FOLDERS.PEOPLE),
    ADMIN: resolveFolder("VAULT_FOLDER_ADMIN", VAULT_FOLDERS.ADMIN),
    ARCHIVE: resolveFolder("VAULT_FOLDER_ARCHIVE", VAULT_FOLDERS.ARCHIVE),
  };

  // Log when any folder deviates from compile-time defaults so operators can
  // confirm their VAULT_FOLDER_* overrides are active.
  const overrides = (Object.keys(resolved) as (keyof VaultFolders)[]).filter((k) => resolved[k] !== VAULT_FOLDERS[k]);
  if (overrides.length > 0) {
    const overrideMap = Object.fromEntries(overrides.map((k) => [k, resolved[k]]));
    logger.info("config", "VAULT_FOLDER_* overrides active — resolved folder map", overrideMap);
  }

  return resolved;
}

/**
 * Build the list of path prefixes to skip when computing cross-reference gaps.
 * Uses the configured folder names rather than the compile-time constants.
 */
export function resolveSkipConnectionPrefixes(folders: VaultFolders): string[] {
  return [
    `${folders.AI_LOGS}/`,
    `${folders.TEMPLATES}/`,
    `${folders.ARCHIVE}/`,
    `${folders.ARTEFACTS}/`,
    `${folders.CANVASES}/`,
  ];
}
