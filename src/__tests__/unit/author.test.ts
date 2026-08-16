import { describe, it, expect } from "vitest";
import {
  UNKNOWN_AUTHOR,
  cleanByline,
  displayAuthor,
  joinNames,
  nameFromRssAuthor,
  resolveAuthor,
} from "../../services/author.ts";

describe("cleanByline", () => {
  it("trims and collapses whitespace", () => {
    expect(cleanByline("  Jane   Doe\n")).toBe("Jane Doe");
  });

  it("strips a leading 'By' prefix", () => {
    expect(cleanByline("By Jane Doe")).toBe("Jane Doe");
    expect(cleanByline("by: Jane Doe")).toBe("Jane Doe");
  });

  it("keeps names that merely start with the letters 'by'", () => {
    expect(cleanByline("Byron Katie")).toBe("Byron Katie");
  });

  it("rejects URLs, which article:author often holds", () => {
    expect(cleanByline("https://facebook.com/jane")).toBe("");
  });

  it("rejects text too long to be a name", () => {
    expect(cleanByline("x".repeat(101))).toBe("");
  });

  it("returns empty for nullish input", () => {
    expect(cleanByline(null)).toBe("");
    expect(cleanByline(undefined)).toBe("");
    expect(cleanByline("   ")).toBe("");
  });
});

describe("nameFromRssAuthor", () => {
  it("extracts the name from the spec'd email (Name) form", () => {
    expect(nameFromRssAuthor("jane@example.com (Jane Doe)")).toBe("Jane Doe");
  });

  it("drops a bare email address rather than publishing it", () => {
    expect(nameFromRssAuthor("jane@example.com")).toBe("");
  });

  it("accepts a plain name", () => {
    expect(nameFromRssAuthor("Jane Doe")).toBe("Jane Doe");
  });
});

describe("joinNames", () => {
  it("joins co-authors", () => {
    expect(joinNames(["Jane Doe", "John Roe"])).toBe("Jane Doe, John Roe");
  });

  it("de-duplicates and drops empties", () => {
    expect(joinNames(["Jane Doe", "", "Jane Doe"])).toBe("Jane Doe");
  });

  it("abbreviates an unbounded list", () => {
    expect(joinNames(["A B", "C D", "E F", "G H", "I J"])).toBe(
      "A B, C D, E F, G H and others",
    );
  });
});

describe("resolveAuthor", () => {
  it("takes the first usable candidate", () => {
    expect(resolveAuthor("", null, "Jane Doe", "Ignored")).toBe("Jane Doe");
  });

  it("skips candidates that clean to nothing", () => {
    expect(resolveAuthor("https://example.com/jane", "Jane Doe")).toBe("Jane Doe");
  });

  it("returns empty when nothing is known, leaving the fallback to callers", () => {
    expect(resolveAuthor("", undefined, null)).toBe("");
  });
});

describe("displayAuthor", () => {
  it("prefers the publication over the sentinel", () => {
    expect(displayAuthor("", "Cloudflare Blog")).toBe("Cloudflare Blog");
  });

  it("falls back to the sentinel only when nothing is known", () => {
    expect(displayAuthor("", "")).toBe(UNKNOWN_AUTHOR);
  });
});
