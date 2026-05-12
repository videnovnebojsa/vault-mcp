import type { ClassifyRules } from "../config.js";

export type { ClassifyRules };

export interface ClassifyResult {
  category: "person" | "project" | "idea" | "admin" | "unknown";
  confidence: number;
  suggested_title: string;
  suggested_folder: string;
  tags: string[];
}

export const DEFAULT_CLASSIFY_RULES: ClassifyRules = {
  person: {
    keywords: ["met", "spoke with", "talked to", "person", "contact", "meeting with", "conversation with"],
    folder: "80_People",
  },
  project: {
    keywords: ["project", "milestone", "sprint", "deadline", "deliverable", "roadmap", "project plan"],
    folder: "10_Projects",
  },
  idea: {
    keywords: ["idea", "concept", "what if", "insight", "hypothesis", "thought", "brainstorm"],
    folder: "30_Zettelkasten",
  },
  admin: {
    keywords: ["invoice", "tax", "admin", "budget", "expense", "receipt", "payment", "contract"],
    folder: "90_Admin",
  },
};

function extractTitle(text: string): string {
  const firstLine = (text.split("\n")[0] ?? "").replace(/^#+\s*/, "").trim();
  if (firstLine.length > 60) {
    return `${firstLine.slice(0, 57)}...`;
  }
  return firstLine || "Untitled";
}

export function classify(text: string, rules: ClassifyRules = DEFAULT_CLASSIFY_RULES): ClassifyResult {
  const lower = text.toLowerCase();

  for (const [category, { keywords, folder }] of Object.entries(rules)) {
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
    suggested_folder: "00_Inbox",
    tags: [],
  };
}
