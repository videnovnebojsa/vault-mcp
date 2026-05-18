import fs from "node:fs/promises";
import path from "node:path";
import { VaultError, VaultErrorCode } from "../utils/errors.js";
import type { AclConfig } from "./types.js";

export class PathTraversalError extends VaultError {
  constructor(message: string) {
    super(message, VaultErrorCode.PATH_TRAVERSAL);
    this.name = "PathTraversalError";
  }
}

export class AclViolationError extends VaultError {
  constructor(message: string) {
    super(message, VaultErrorCode.ACL_VIOLATION);
    this.name = "AclViolationError";
  }
}

/**
 * Resolve a vault-relative path to an absolute path, ensuring it stays within the vault root.
 * This performs a string-based check only. Use assertRealPathSafe() for symlink-safe validation.
 */
export function resolveVaultPath(root: string, relative: string): string {
  // Strip leading slashes to treat as relative
  const cleaned = relative.replace(/^\/+/, "");
  const resolved = path.resolve(root, cleaned);
  const normalizedRoot = path.resolve(root);

  if (!resolved.startsWith(normalizedRoot + path.sep) && resolved !== normalizedRoot) {
    throw new PathTraversalError(`Path "${relative}" resolves outside vault root`);
  }

  return resolved;
}

/**
 * Verify that an absolute path resolves within the vault root after following symlinks.
 * For existing paths, checks realpath of the file. For new paths, checks realpath of
 * the nearest existing ancestor.
 */
export async function assertRealPathSafe(root: string, absPath: string, knownRealRoot?: string): Promise<void> {
  const realRoot = knownRealRoot ?? (await fs.realpath(root));

  // Walk up to find the nearest existing ancestor
  let check = absPath;
  while (check !== path.dirname(check)) {
    try {
      const realCheck = await fs.realpath(check);
      if (realCheck !== realRoot && !realCheck.startsWith(realRoot + path.sep)) {
        throw new PathTraversalError(`Path resolves outside vault root via symlink`);
      }
      return;
    } catch (err) {
      if (err instanceof PathTraversalError) throw err;
      // Path doesn't exist yet, check parent
      check = path.dirname(check);
    }
  }
}

/**
 * Append .md extension if missing.
 */
export function ensureMarkdownPath(filePath: string): string {
  if (filePath.endsWith(".md")) {
    return filePath;
  }
  return `${filePath}.md`;
}

/**
 * Convert an absolute path to a vault-relative path with forward slashes.
 */
export function toVaultRelative(root: string, absPath: string): string {
  const normalizedRoot = path.resolve(root);
  const normalizedAbs = path.resolve(absPath);
  const rel = path.relative(normalizedRoot, normalizedAbs);
  return rel.split(path.sep).join("/");
}

function matchesAclPrefix(prefixes: string[], rel: string): boolean {
  for (const raw of prefixes) {
    const p = raw.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
    if (p === "" || rel === p || rel.startsWith(`${p}/`)) return true;
  }
  return false;
}

/**
 * Enforce allow/deny ACL against an absolute path.
 * Deny takes precedence over allow. Both lists empty = no restriction.
 */
export function assertAclSafe(root: string, absPath: string, acl: AclConfig): void {
  if (acl.allowPaths.length === 0 && acl.denyPaths.length === 0) return;

  const vaultRel = toVaultRelative(root, absPath);

  if (acl.denyPaths.length > 0 && matchesAclPrefix(acl.denyPaths, vaultRel)) {
    throw new AclViolationError(`Access denied: "${vaultRel}" is in a restricted folder`);
  }

  if (acl.allowPaths.length > 0 && !matchesAclPrefix(acl.allowPaths, vaultRel)) {
    throw new AclViolationError(`Access denied: "${vaultRel}" is outside allowed folders`);
  }
}

/**
 * Return true when a vault-relative path passes the ACL (deny/allow lists).
 * Used for filtering index results that bypass the repository layer.
 */
export function isAclAllowed(vaultRel: string, acl: AclConfig): boolean {
  if (acl.allowPaths.length === 0 && acl.denyPaths.length === 0) return true;
  if (acl.denyPaths.length > 0 && matchesAclPrefix(acl.denyPaths, vaultRel)) return false;
  if (acl.allowPaths.length > 0 && !matchesAclPrefix(acl.allowPaths, vaultRel)) return false;
  return true;
}
