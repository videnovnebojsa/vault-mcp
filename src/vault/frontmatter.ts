import matter from "gray-matter";
import yaml from "js-yaml";
import { frontmatterSchema } from "./schema.js";
import type { VaultFrontmatter } from "./types.js";

// gray-matter bundles js-yaml 3.x which uses the removed safeLoad/safeDump API.
// Pass js-yaml 4.x explicitly as a custom engine so the override in package.json
// (which pins js-yaml to ^4.1.1 for CVE hygiene) doesn't break parsing.
const yamlEngine = {
  parse: (src: string) => yaml.load(src) as Record<string, unknown>,
  stringify: (obj: unknown) => yaml.dump(obj),
};

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
  const { content, data } = matter(raw, { engines: { yaml: yamlEngine } });
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
  return matter.stringify(content, frontmatter, { engines: { yaml: yamlEngine } });
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
