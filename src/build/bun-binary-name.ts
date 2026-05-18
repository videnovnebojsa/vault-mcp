import path from "node:path";

export function resolveBunBinaryName(rawName: string | undefined): string {
  const name = rawName ?? "vault-mcp";
  if (name.length === 0 || name !== path.basename(name)) {
    throw new Error("BUN_BINARY_NAME must be a file name");
  }
  return name;
}
