import type { VaultFolders } from "../config/folders.js";

export interface CaptureClassification {
  category: "person" | "project" | "idea" | "admin" | "unknown";
  confidence: number;
  suggested_title: string;
  tags: string[];
  properties: Record<string, unknown>;
  sensitivity?: "low" | "high";
}

interface ExtractedTask {
  text: string;
  due_date: string | null;
  owner: string | null;
  priority: number;
}

export interface CaptureResult {
  ok: boolean;
  notePath?: string;
  classification?: CaptureClassification;
  extractedTasks?: ExtractedTask[];
  message: string;
}

export interface SecondBrainConfig {
  vaultPath: string;
  logRawInput: boolean;
  enableCapturePipeline: boolean;
  folders: VaultFolders;
}
