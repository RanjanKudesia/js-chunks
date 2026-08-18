/**
 * fitTokens — the pure-TS token-budget helper.
 *
 * These mirror py_chunks/tests/test_fit_tokens.py case for case, because the
 * two implementations are meant to behave the same even though fitTokens is
 * deliberately parity-exempt (its output depends on the counter you pass, so it
 * cannot be part of the byte-identical contract the engine holds).
 *
 * The extra `describe("option validation")` block has no Python ancestor in the
 * original draft: both SDKs used to accept an unrecognised `split` / `merge` /
 * `mergeMetadata` / `oversize` value and silently fall through to a different
 * strategy. A typo should not quietly change how a document is chunked.
 */

import { describe, expect, it } from "vitest";
import { ChunkError, fitTokens, type Chunk } from "../src/index.ts";

/** Stand-in tokenizer: one token per whitespace-separated word. */
const words = (text: string): number => text.split(/\s+/).filter((w) => w !== "").length;

function chunk(content: string, metadata: Record<string, unknown> = {}): Chunk {
  return { content, contentType: "paragraph", metadata };
}

function expectChunkError(run: () => unknown, message?: string): ChunkError {
  try {
    run();
  } catch (e) {
    expect(e).toBeInstanceOf(ChunkError);
    const err = e as ChunkError;
    expect(err.kind).toBe("invalid-arg");
    if (message !== undefined) expect(err.message).toBe(message);
    return err;
  }
  expect.unreachable("expected fitTokens to throw");
}

describe("fitTokens", () => {
  describe("budget", () => {
    it("leaves nothing over the budget", () => {
      const out = fitTokens([chunk(Array.from({ length: 500 }, () => "word").join(" "))], words, 50);
      expect(out.length).toBeGreaterThan(0);
      for (const c of out) expect(words(c.content)).toBeLessThanOrEqual(50);
    });

    it("passes already-fitting chunks through untouched", () => {
      const src = [chunk("one two three"), chunk("four five")];
      const out = fitTokens(src, words, 100);
      expect(out.map((c) => c.content)).toEqual(["one two three", "four five"]);
    });

    it("returns [] for empty input", () => {
      expect(fitTokens([], words, 100)).toEqual([]);
    });

    for (const bad of [0, -1]) {
      it(`rejects budget ${bad}`, () => {
        expectChunkError(() => fitTokens([chunk("x")], words, bad), "budget must be greater than 0");
      });
    }

    it("rejects a negative minTokens", () => {
      expectChunkError(
        () => fitTokens([chunk("x")], words, 10, { minTokens: -1 }),
        "minTokens must not be negative",
      );
    });

    it("marks split parts with fit_part and fit_total", () => {
      const out = fitTokens([chunk(Array.from({ length: 40 }, () => "w").join(" "))], words, 5);
      expect(out.length).toBeGreaterThan(1);
      expect(out[0]!.metadata.fit_part).toBe(1);
      expect(out[0]!.metadata.fit_total).toBe(out.length);
    });
  });

  describe("oversize policy", () => {
    it("keep emits an indivisible chunk whole", () => {
      const out = fitTokens([chunk("x".repeat(400))], words, 1, { oversize: "keep" });
      expect(out).toHaveLength(1);
    });

    it("error names the problem", () => {
      const err = expectChunkError(() =>
        fitTokens([chunk("a b c d e f")], words, 2, { oversize: "error" }),
      );
      expect(err.message).toContain("exceeds budget");
    });

    it("split never loses content", () => {
      const source = Array.from({ length: 100 }, (_, i) => `w${i}`).join(" ");
      const out = fitTokens([chunk(source)], words, 7);
      const emitted = out.flatMap((c) => c.content.split(/\s+/).filter((w) => w !== ""));
      expect(emitted.sort()).toEqual(source.split(" ").sort());
    });
  });

  describe("merging", () => {
    it("merges short chunks forward", () => {
      const src = [chunk("a"), chunk("b"), chunk("c")];
      const out = fitTokens(src, words, 100, { minTokens: 5 });
      expect(out.length).toBeLessThan(src.length);
    });

    it("merge: none leaves them alone", () => {
      const src = [chunk("a"), chunk("b")];
      expect(fitTokens(src, words, 100, { minTokens: 5, merge: "none" })).toHaveLength(2);
    });

    it("never merges across a section boundary", () => {
      const src = [chunk("a", { section_heading: "A" }), chunk("b", { section_heading: "B" })];
      const out = fitTokens(src, words, 100, { minTokens: 50 });
      expect(out).toHaveLength(2);
      expect(out.map((c) => c.metadata.section_heading)).toEqual(["A", "B"]);
    });

    it("respectBoundaries: false ignores them", () => {
      const src = [chunk("a", { section_heading: "A" }), chunk("b", { section_heading: "B" })];
      expect(fitTokens(src, words, 100, { minTokens: 50, respectBoundaries: false })).toHaveLength(1);
    });

    it("union metadata keeps both values", () => {
      const src = [chunk("a", { page_number: 1 }), chunk("b", { page_number: 2 })];
      const out = fitTokens(src, words, 100, {
        minTokens: 50,
        respectBoundaries: false,
        mergeMetadata: "union",
      });
      expect(out[0]!.metadata.page_number).toEqual([1, 2]);
    });

    it("first metadata does not invent values", () => {
      const src = [chunk("a", { page_number: 1 }), chunk("b", { page_number: 2 })];
      const out = fitTokens(src, words, 100, {
        minTokens: 50,
        respectBoundaries: false,
        mergeMetadata: "first",
      });
      expect(out[0]!.metadata.page_number).toBe(1);
    });

    it("union does not duplicate an equal array value", () => {
      const src = [chunk("a", { tags: ["x"] }), chunk("b", { tags: ["x"] })];
      const out = fitTokens(src, words, 100, {
        minTokens: 50,
        respectBoundaries: false,
        mergeMetadata: "union",
      });
      expect(out[0]!.metadata.tags).toEqual(["x"]);
    });
  });

  describe("does not mutate input", () => {
    it("leaves the source chunks untouched", () => {
      const src = [chunk("one two three four five", { page_number: 1 })];
      fitTokens(src, words, 1);
      expect(src[0]!.content).toBe("one two three four five");
      expect(src[0]!.metadata).toEqual({ page_number: 1 });
    });
  });

  describe("option validation", () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["split", { split: "sentances" }, 'split must be one of "sentence", "paragraph", "hard", got "sentances".'],
      ["merge", { merge: "backward" }, 'merge must be one of "forward", "none", got "backward".'],
      ["mergeMetadata", { mergeMetadata: "both" }, 'mergeMetadata must be one of "first", "union", got "both".'],
      ["oversize", { oversize: "truncate" }, 'oversize must be one of "split", "keep", "error", got "truncate".'],
    ];

    for (const [label, opts, message] of cases) {
      it(`rejects an unrecognised ${label} instead of silently falling through`, () => {
        expectChunkError(() => fitTokens([chunk("x")], words, 10, opts), message);
      });
    }

    it("rejects a non-integer budget", () => {
      expectChunkError(() => fitTokens([chunk("x")], words, 2.5), "budget must be an integer, got 2.5.");
    });

    it("rejects a counter that is not a function", () => {
      expectChunkError(
        () => fitTokens([chunk("x")], "nope" as unknown as (s: string) => number, 10),
        "counter must be a function, got string.",
      );
    });
  });
});
