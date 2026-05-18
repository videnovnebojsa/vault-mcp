import { VaultErrorCode } from "../../utils/errors.js";
import type { VaultServices } from "../../vault/manager.js";
import { readSection } from "../../vault/markdown.js";
import { errorResult, successResult, type ToolResult } from "../format.js";

export async function handleVaultReadSection(
  args: { path: string; heading: string; vault?: string | undefined },
  services: VaultServices,
): Promise<ToolResult> {
  const { vault } = services;
  const note = await vault.readNote(args.path);
  const section = readSection(note.content, args.heading);
  if (!section) {
    return errorResult(VaultErrorCode.NOT_FOUND, `Heading "${args.heading}" not found in ${args.path}`);
  }
  return successResult({ path: args.path, heading: args.heading, content: section });
}
