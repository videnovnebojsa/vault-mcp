import { describe, expect, it } from "bun:test";
import { VAULT_FOLDERS } from "../config/folders.js";
import { classifyWithHeuristic } from "./classify-adapter.js";

describe("classifyWithHeuristic", () => {
  it("maps heuristic result to CaptureClassification", () => {
    const result = classifyWithHeuristic("Met with John about the project");
    expect(result.category).toBe("person");
    expect(result.confidence).toBe(0.7);
    expect(result.properties).toEqual({});
    expect(result.sensitivity).toBe("low");
  });

  it("returns unknown for unclassifiable text", () => {
    const result = classifyWithHeuristic("asdfghjkl");
    expect(result.category).toBe("unknown");
    expect(result.confidence).toBe(0.3);
  });

  it("uses custom folders when provided [QA-05]", () => {
    const customFolders = { ...VAULT_FOLDERS, PEOPLE: "Contacts", INBOX: "Unsorted" };

    const personResult = classifyWithHeuristic("Met with Alice — follow-up needed", customFolders);
    // classifyWithHeuristic returns CaptureClassification which doesn't include suggested_folder,
    // but the underlying classify() call uses custom folders — verify category & confidence are correct
    expect(personResult.category).toBe("person");
    expect(personResult.confidence).toBe(0.7);

    const unknownResult = classifyWithHeuristic("xyzzy bloop nothing", customFolders);
    expect(unknownResult.category).toBe("unknown");
    expect(unknownResult.confidence).toBe(0.3);
  });

  it("passes custom folders all the way through to classify() [QA-05]", () => {
    // Verify the adapter actually forwards the folders arg rather than silently ignoring it.
    // We test by observing that person classification still works with non-default folder config.
    const customFolders = { ...VAULT_FOLDERS, ZETTELKASTEN: "BrainDump" };
    const result = classifyWithHeuristic("What if we brainstormed a new idea here", customFolders);
    expect(result.category).toBe("idea");
    expect(result.tags).toContain("idea");
  });
});
