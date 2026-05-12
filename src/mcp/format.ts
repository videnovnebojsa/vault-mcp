import type { VaultNote } from "../vault/types.js";

/** Strip internal-only fields before sending a VaultNote to an MCP client. */
export function toClientNote(note: VaultNote): Omit<VaultNote, "absPath"> {
  const { absPath: _, ...safe } = note;
  return safe;
}
