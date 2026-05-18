/**
 * Extract wikilinks ([[Note Title]] or [[path/to/note|alias]]) from markdown content.
 * Returns a deduplicated array of link targets (without alias).
 */
export function extractWikilinks(content: string): string[] {
  const links: string[] = [];
  for (const m of content.matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
    const target = ((m[1] ?? "").split("#")[0] ?? "").trim();
    if (target) links.push(target);
  }
  return [...new Set(links)];
}

/**
 * Extract a named heading section from markdown content.
 * Returns the heading line and all lines beneath it until the next
 * same-or-higher heading, or null if the heading is not found.
 */
export function readSection(content: string, heading: string): string | null {
  const lines = content.split("\n");
  let inSection = false;
  let sectionLevel = 0;
  const sectionLines: string[] = [];

  for (const line of lines) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
    if (headingMatch) {
      const level = (headingMatch[1] ?? "").length;
      const title = (headingMatch[2] ?? "").trim();
      if (!inSection) {
        if (title.toLowerCase() === heading.toLowerCase()) {
          inSection = true;
          sectionLevel = level;
          sectionLines.push(line);
        }
      } else {
        if (level <= sectionLevel) break;
        sectionLines.push(line);
      }
    } else if (inSection) {
      sectionLines.push(line);
    }
  }

  return sectionLines.length > 0 ? sectionLines.join("\n") : null;
}
