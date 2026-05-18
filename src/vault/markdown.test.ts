import { describe, expect, it } from "bun:test";
import { extractWikilinks } from "./markdown.js";

describe("extractWikilinks", () => {
  it("strips aliases and heading anchors from wikilink targets", () => {
    expect(extractWikilinks("[[Note#Heading]] [[Folder/Other|alias]] [[Plain]]")).toEqual([
      "Note",
      "Folder/Other",
      "Plain",
    ]);
  });
});
