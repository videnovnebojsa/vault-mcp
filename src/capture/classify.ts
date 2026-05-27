import { VAULT_FOLDERS, type VaultFolders } from "../config/folders.js";
import type { ClassifyRules } from "../config.js";

export type { ClassifyRules };

export interface ClassifyResult {
  category: "person" | "project" | "idea" | "admin" | "unknown";
  confidence: number;
  suggested_title: string;
  suggested_folder: string;
  tags: string[];
}

// Memoize by object reference — the same VaultFolders instance is stable within
// a single boot, so we avoid re-allocating the rules object on every classify() call.
let _memoFolders: VaultFolders | undefined;
let _memoRules: ClassifyRules | undefined;

export function buildDefaultClassifyRules(folders: VaultFolders): ClassifyRules {
  if (folders !== _memoFolders || !_memoRules) {
    _memoFolders = folders;
    _memoRules = {
      person: {
        keywords: ["met", "spoke with", "talked to", "person", "contact", "meeting with", "conversation with"],
        folder: folders.PEOPLE,
      },
      project: {
        keywords: ["project", "milestone", "sprint", "deadline", "deliverable", "roadmap", "project plan"],
        folder: folders.PROJECTS,
      },
      idea: {
        keywords: ["idea", "concept", "what if", "insight", "hypothesis", "thought", "brainstorm"],
        folder: folders.ZETTELKASTEN,
      },
      admin: {
        keywords: ["invoice", "tax", "admin", "budget", "expense", "receipt", "payment", "contract"],
        folder: folders.ADMIN,
      },
    };
  }
  return _memoRules;
}

function extractTitle(text: string): string {
  const firstLine = (text.split("\n")[0] ?? "").replace(/^#+\s*/, "").trim();
  if (firstLine.length > 60) {
    return `${firstLine.slice(0, 57)}...`;
  }
  return firstLine || "Untitled";
}

export function classify(text: string, rules?: ClassifyRules, folders: VaultFolders = VAULT_FOLDERS): ClassifyResult {
  const effectiveRules = rules ?? buildDefaultClassifyRules(folders);
  const lower = text.toLowerCase();

  for (const [category, { keywords, folder }] of Object.entries(effectiveRules)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) {
        return {
          category: category as ClassifyResult["category"],
          confidence: 0.7,
          suggested_title: extractTitle(text),
          suggested_folder: folder,
          tags: [category],
        };
      }
    }
  }

  return {
    category: "unknown",
    confidence: 0.3,
    suggested_title: extractTitle(text),
    suggested_folder: folders.INBOX,
    tags: [],
  };
}
