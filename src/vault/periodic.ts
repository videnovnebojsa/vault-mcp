import type { VaultRepository } from "./repository.js";
import type { VaultNote } from "./types.js";

export type Period = "daily" | "weekly" | "monthly";

function isoWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

export function buildPeriodicPath(period: Period, date: Date, root: string): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const cleanRoot = root.replace(/\/$/, "");

  switch (period) {
    case "daily":
      return `${cleanRoot}/${year}/${year}-${month}-${day}.md`;
    case "weekly": {
      const week = String(isoWeek(date)).padStart(2, "0");
      return `${cleanRoot}/${year}/${year}-W${week}.md`;
    }
    case "monthly":
      return `${cleanRoot}/${year}/${year}-${month}.md`;
  }
}

export async function openOrCreatePeriodicNote(
  vault: VaultRepository,
  period: Period,
  date: Date,
  root: string,
): Promise<VaultNote> {
  const notePath = buildPeriodicPath(period, date, root);
  const pathWithoutExtension = notePath.replace(/\.md$/, "");

  try {
    return await vault.readNote(pathWithoutExtension);
  } catch {
    const isoDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    await vault.writeNote(pathWithoutExtension, {
      content: "",
      frontmatter: { type: "periodic", period, date: isoDate },
    });
    return vault.readNote(pathWithoutExtension);
  }
}
