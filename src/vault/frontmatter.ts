import matter from "gray-matter";
import { frontmatterSchema } from "./schema.js";
import type { VaultFrontmatter } from "./types.js";

export interface ParsedNote {
  content: string;
  frontmatter: VaultFrontmatter;
  raw: string;
}

export interface ValidationResult {
  ok: boolean;
  errors?: string[];
}

export function parseFrontmatter(raw: string): ParsedNote {
  const { content, data } = matter(raw);
  return {
    content,
    frontmatter: data as VaultFrontmatter,
    raw,
  };
}

export function serializeNote(content: string, frontmatter: VaultFrontmatter): string {
  const hasFields = Object.keys(frontmatter).length > 0;
  if (!hasFields) {
    return content;
  }
  return matter.stringify(content, frontmatter);
}

export function validateFrontmatter(fm: unknown, opts?: { requireType?: boolean }): ValidationResult {
  const result = frontmatterSchema.safeParse(fm);
  if (!result.success) {
    return {
      ok: false,
      errors: result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
    };
  }

  if (opts?.requireType && !result.data.type) {
    return {
      ok: false,
      errors: ["type: Required"],
    };
  }

  return { ok: true };
}
