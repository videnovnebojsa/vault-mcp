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

/** Paths skipped when computing cross-reference gaps (connections.ts). */
export const DEFAULT_SKIP_CONNECTION_PREFIXES: string[] = [
  `${VAULT_FOLDERS.AI_LOGS}/`,
  `${VAULT_FOLDERS.TEMPLATES}/`,
  `${VAULT_FOLDERS.ARCHIVE}/`,
  `${VAULT_FOLDERS.ARTEFACTS}/`,
  `${VAULT_FOLDERS.CANVASES}/`,
];
