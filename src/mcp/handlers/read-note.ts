import type { VaultServices } from "../../vault/manager.js";
import { successResult, type ToolResult, toClientNote } from "../format.js";

export async function handleVaultReadNote(
  args: { path: string; vault?: string | undefined },
  services: VaultServices,
): Promise<ToolResult> {
  const { vault } = services;
  const note = await vault.readNote(args.path);
  return successResult(toClientNote(note));
}
