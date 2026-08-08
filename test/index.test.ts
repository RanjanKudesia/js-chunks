import { describe, it, expect, beforeAll, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  getChunks,
  getMarkdown,
  chunkPdfMarkdown,
  normalizePdfMarkdown,
  streamChunks,
  ChunkError,
  type Chunk,
  type ChunkImage,
} from "../src/index.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Fixture resolution, in order:
 *  1. the full workspace corpus at ../../test_files, when present
 *  2. the committed subset at test/fixtures/ (what CI uses)
 *  3. fail loudly.
 *
 * Set JS_CHUNKS_FIXTURES=local to force the committed subset even when the
 * corpus exists (used to verify the CI path locally).
 */
function resolveFixtures(): string {
  if (process.env.JS_CHUNKS_FIXTURES !== "local") {
    const corpus = path.resolve(__dirname, "../../test_files");
    if (fs.existsSync(path.join(corpus, "md/test.md"))) return corpus;
  }
  const local = path.resolve(__dirname, "fixtures");
  if (fs.existsSync(path.join(local, "md/test.md"))) return local;
  throw new Error(
    "No test fixtures found: neither the workspace corpus (../../test_files) " +
      "nor the committed subset (test/fixtures/) is present.",
  );
}

const FIXTURES = resolveFixtures();

const MD_PATH = path.join(FIXTURES, "md/test.md");
const DOCX_IMG_PATH = path.join(FIXTURES, "docx/all_round.docx");
const PDF_PATH = path.join(FIXTURES, "pdf/sample-pdf.pdf");

// Pick the smallest .docx fixture under 1MB.
function smallestDocx(): string {
  const dir = path.join(FIXTURES, "docx");
  const candidates = fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(".docx"))
    .map((f) => path.join(dir, f))
    .filter((p) => fs.statSync(p).size < 1024 * 1024)
    .sort((a, b) => fs.statSync(a).size - fs.statSync(b).size);
  if (candidates.length === 0) throw new Error("no small docx fixture found");
  return candidates[0]!;
}

let DOCX_PATH: string;

/**
 * Push a deliberately-wrong runtime value into the typed `opts` slot.
 * These tests exist precisely because JS callers are not bound by the types.
 */
function badOpts(value: unknown): undefined {
  return value as undefined;
}

function assertWellFormed(chunks: Chunk[]) {
  expect(Array.isArray(chunks)).toBe(true);
  expect(chunks.length).toBeGreaterThan(0);
  for (const c of chunks) {
    expect(typeof c.content).toBe("string");
    expect(typeof c.contentType).toBe("string");
    expect(c.contentType.length).toBeGreaterThan(0);
    expect(c.metadata).toBeTypeOf("object");
    expect(c.metadata).not.toBeNull();
    // snake_case must not leak into the public shape.
    expect((c as Record<string, unknown>).content_type).toBeUndefined();
  }
}

describe("js-chunks", () => {
  beforeAll(() => {
    DOCX_PATH = smallestDocx();
  });

  it("getChunks on a real markdown path returns well-formed chunks", async () => {
    const chunks = await getChunks(MD_PATH);
    assertWellFormed(chunks);
  });

  it("getChunks accepts a Uint8Array with an explicit filename", async () => {
    const bytes = new Uint8Array(fs.readFileSync(MD_PATH));
    const chunks = await getChunks(bytes, { filename: "test.md" });
    assertWellFormed(chunks);
  });

  it("getChunks accepts a Node Buffer with an explicit filename", async () => {
    const buf = fs.readFileSync(MD_PATH); // Buffer
    const chunks = await getChunks(buf, { filename: "test.md" });
    assertWellFormed(chunks);
  });

  it("getChunks accepts an ArrayBuffer with an explicit filename", async () => {
    const buf = fs.readFileSync(MD_PATH);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    const chunks = await getChunks(ab, { filename: "test.md" });
    assertWellFormed(chunks);
  });

  it("getChunks works on a real docx fixture", async () => {
    const chunks = await getChunks(DOCX_PATH);
    assertWellFormed(chunks);
  });

  it("respects the mode option", async () => {
    const chunks = await getChunks(MD_PATH, { mode: "sentence" });
    assertWellFormed(chunks);
  });

  it("getMarkdown returns a non-empty string", async () => {
    const md = await getMarkdown(DOCX_PATH);
    expect(typeof md).toBe("string");
    expect(md.length).toBeGreaterThan(0);
  });

  it("rejects byte sources without a filename", async () => {
    const bytes = new Uint8Array(fs.readFileSync(MD_PATH));
    await expect(getChunks(bytes)).rejects.toThrow(/filename is required/i);
  });

  // Host-side argument validation never reaches the engine, but it must still
  // be a ChunkError so `catch (e instanceof ChunkError)` is the COMPLETE
  // contract for this package. Messages are pinned verbatim — they are part of
  // the public surface and predate the ChunkError wrapping.
  describe("host-side validation throws ChunkError", () => {
    it("missing filename for a byte source", async () => {
      const bytes = new Uint8Array(fs.readFileSync(MD_PATH));
      try {
        await getChunks(bytes);
        expect.unreachable("expected getChunks to throw");
      } catch (e) {
        expect(e).toBeInstanceOf(ChunkError);
        const err = e as ChunkError;
        expect(err.name).toBe("ChunkError");
        expect(err.kind).toBe("invalid-arg");
        expect(err.message).toBe(
          "A filename is required for byte sources (pass opts.filename or a named Blob) so the engine can route by extension.",
        );
      }
    });

    it("a Blob with no name and no opts.filename", async () => {
      const blob = new Blob([fs.readFileSync(MD_PATH)]);
      try {
        await getChunks(blob);
        expect.unreachable("expected getChunks to throw");
      } catch (e) {
        expect(e).toBeInstanceOf(ChunkError);
        expect((e as ChunkError).kind).toBe("invalid-arg");
      }
    });

    it("an unsupported source type", async () => {
      try {
        await getChunks(42 as unknown as Parameters<typeof getChunks>[0]);
        expect.unreachable("expected getChunks to throw");
      } catch (e) {
        expect(e).toBeInstanceOf(ChunkError);
        const err = e as ChunkError;
        expect(err.kind).toBe("invalid-arg");
        expect(err.message).toBe(
          "Unsupported source: expected a string path, Uint8Array, ArrayBuffer, Buffer, or Blob.",
        );
      }
    });

    it("a path that does not exist", async () => {
      // The filesystem read sat outside the wrapping, so ENOENT escaped as
      // Node's own Error and `instanceof ChunkError` was false for the single
      // most common failure a caller hits.
      try {
        await getChunks("./definitely-not-here.md");
        expect.unreachable("expected getChunks to throw");
      } catch (e) {
        expect(e).toBeInstanceOf(ChunkError);
        const err = e as ChunkError;
        expect(err.name).toBe("ChunkError");
        expect(err.kind).toBe("io");
        // Node's own message is preserved — it names the path.
        expect(err.message).toContain("ENOENT");
        expect(err.message).toContain("definitely-not-here.md");
      }
    });

    it("getMarkdown validates the same way", async () => {
      const bytes = new Uint8Array(fs.readFileSync(MD_PATH));
      await expect(getMarkdown(bytes)).rejects.toBeInstanceOf(ChunkError);
    });

    it("a filesystem path off Node", async () => {
      // `isNode` is evaluated once at module load and excludes Deno, so load a
      // fresh copy of the module with a fake `Deno` global to exercise the
      // non-Node path branch.
      vi.resetModules();
      vi.stubGlobal("Deno", { version: { deno: "test" } });
      try {
        const fresh = (await import("../src/index.ts")) as typeof import("../src/index.ts");
        try {
          await fresh.getChunks(MD_PATH);
          expect.unreachable("expected getChunks to throw");
        } catch (e) {
          expect(e).toBeInstanceOf(fresh.ChunkError);
          const err = e as InstanceType<typeof fresh.ChunkError>;
          expect(err.name).toBe("ChunkError");
          expect(err.kind).toBe("invalid-arg");
          expect(err.message).toBe(
            "Filesystem paths are only supported on Node. Pass a Uint8Array/ArrayBuffer/Blob with opts.filename instead.",
          );
        }
      } finally {
        vi.unstubAllGlobals();
        vi.resetModules();
      }
    });
  });

  // The options object is caller-controlled: it can be `null`, not an object at
  // all, or carry getters that throw. Each of these escaped the ChunkError
  // contract as a raw TypeError / the caller's own error.
  describe("the options object never escapes the ChunkError contract", () => {
    async function expectChunkError(
      run: () => Promise<unknown>,
      kind: ChunkError["kind"],
      message?: string | RegExp,
    ): Promise<ChunkError> {
      try {
        await run();
        return expect.unreachable("expected a ChunkError") as never;
      } catch (e) {
        expect(e).toBeInstanceOf(ChunkError);
        const err = e as ChunkError;
        expect(err.kind).toBe(kind);
        if (typeof message === "string") expect(err.message).toBe(message);
        else if (message) expect(err.message).toMatch(message);
        return err;
      }
    }

    it("getChunks(bytes, null) is a ChunkError, not a TypeError", async () => {
      const bytes = new Uint8Array(fs.readFileSync(MD_PATH));
      await expectChunkError(
        () => getChunks(bytes, badOpts(null)),
        "invalid-arg",
        /filename is required/i,
      );
    });

    it("getMarkdown(bytes, null) is a ChunkError, not a TypeError", async () => {
      const bytes = new Uint8Array(fs.readFileSync(MD_PATH));
      await expectChunkError(
        () => getMarkdown(bytes, badOpts(null)),
        "invalid-arg",
        /filename is required/i,
      );
    });

    it("null options on a path source mean 'no options'", async () => {
      assertWellFormed(await getChunks(MD_PATH, badOpts(null)));
    });

    it("a non-object options argument is rejected by name", async () => {
      await expectChunkError(
        () => getChunks(MD_PATH, badOpts(42)),
        "invalid-arg",
        "opts must be an object, got number.",
      );
    });

    it("a throwing getter on opts becomes a ChunkError", async () => {
      const opts = {
        get windowSize(): number {
          throw new Error("boom");
        },
      };
      await expectChunkError(
        () => getChunks(MD_PATH, badOpts(opts)),
        "invalid-arg",
        /^opts\.windowSize could not be read: boom$/,
      );
    });

    it("streamChunks does not let a throwing getter escape either", async () => {
      // `{ ...opts }` invoked the getter, so this escaped even though
      // streamChunks reads no option itself.
      const opts = {
        get mode(): string {
          throw new Error("boom");
        },
      };
      await expectChunkError(
        async () => {
          for await (const _c of streamChunks(MD_PATH, badOpts(opts))) {
            // unreachable
          }
        },
        "invalid-arg",
        /^opts\.mode could not be read: boom$/,
      );
    });

    it("a Blob whose arrayBuffer() rejects becomes a ChunkError", async () => {
      class BrokenBlob extends Blob {
        override arrayBuffer(): Promise<ArrayBuffer> {
          return Promise.reject(new Error("blob read failed"));
        }
      }
      const blob = new BrokenBlob([fs.readFileSync(MD_PATH)]);
      // Failing to read the source's bytes is the same condition the path
      // branch reports as `io`.
      await expectChunkError(
        () => getChunks(blob, { filename: "test.md" }),
        "io",
        "blob read failed",
      );
    });
  });

  // The wasm boundary takes `usize`, so these were coerced instead of
  // rejected: -1 returned chunks, 2.5 truncated, "3" coerced, and a non-string
  // filename/mode surfaced as kind "unknown" with "memory access out of
  // bounds".
  describe("numeric and type validation of options", () => {
    const cases: Array<[string, Record<string, unknown>, string]> = [
      ["windowSize: -1", { windowSize: -1 }, "window_size must be greater than 0"],
      [
        "sentencesPerChunk: -1",
        { sentencesPerChunk: -1 },
        "sentences_per_chunk must be greater than 0",
      ],
      [
        "paragraphsPerPage: -1",
        { paragraphsPerPage: -1 },
        "paragraphs_per_page must be greater than 0",
      ],
      ["overlap: -1", { overlap: -1 }, "overlap must not be negative, got -1."],
      ["windowSize: 2.5", { windowSize: 2.5 }, "windowSize must be an integer, got 2.5."],
      ["windowSize: '3'", { windowSize: "3" }, "windowSize must be a number, got string."],
      ["windowSize: NaN", { windowSize: NaN }, "windowSize must be a number, got number."],
      ["filename: 42", { filename: 42 }, "filename must be a string, got number."],
      ["mode: 42", { mode: 42 }, "mode must be a string, got number."],
    ];

    for (const [label, opts, message] of cases) {
      it(`rejects ${label} with the ChunkError contract`, async () => {
        try {
          await getChunks(MD_PATH, badOpts(opts));
          expect.unreachable("expected getChunks to throw");
        } catch (e) {
          expect(e).toBeInstanceOf(ChunkError);
          const err = e as ChunkError;
          expect(err.kind).toBe("invalid-arg");
          expect(err.message).toBe(message);
        }
      });
    }

    it("overlap: 0 stays legal", async () => {
      assertWellFormed(await getChunks(MD_PATH, { mode: "sliding_window", windowSize: 3, overlap: 0 }));
    });
  });

  // EPUB never ran the shared argument check, so bad arguments produced an
  // EMPTY ARRAY instead of an error. Driven through the bytes route with
  // deliberately unparseable bytes: validation runs before any parsing, so the
  // check is proven without needing a real book in the committed fixture set.
  describe("EPUB validates its mode arguments", () => {
    const notAnEpub = new Uint8Array([1, 2, 3, 4]);

    it("rejects overlap >= windowSize instead of returning []", async () => {
      try {
        await getChunks(notAnEpub, {
          filename: "x.epub",
          mode: "sliding_window",
          windowSize: 100,
          overlap: 100,
        });
        expect.unreachable("expected getChunks to throw");
      } catch (e) {
        expect(e).toBeInstanceOf(ChunkError);
        expect((e as ChunkError).kind).toBe("invalid-arg");
        expect((e as ChunkError).message).toBe("overlap must be less than window_size");
      }
    });

    it("rejects an unknown mode with the engine's per-format sentence", async () => {
      try {
        await getChunks(notAnEpub, {
          filename: "x.epub",
          mode: "nope" as unknown as import("../src/index.ts").ChunkMode,
        });
        expect.unreachable("expected getChunks to throw");
      } catch (e) {
        expect(e).toBeInstanceOf(ChunkError);
        expect((e as ChunkError).kind).toBe("invalid-arg");
        expect((e as ChunkError).message).toMatch(/^mode must be one of \[.*\] for EPUB, got: 'nope'$/);
      }
    });

    it("rejects paragraphsPerPage = 0 in page_aware mode", async () => {
      try {
        await getChunks(notAnEpub, {
          filename: "x.epub",
          mode: "page_aware",
          paragraphsPerPage: 0,
        });
        expect.unreachable("expected getChunks to throw");
      } catch (e) {
        expect(e).toBeInstanceOf(ChunkError);
        expect((e as ChunkError).kind).toBe("invalid-arg");
        expect((e as ChunkError).message).toBe("paragraphs_per_page must be greater than 0");
      }
    });
  });

  // The spreadsheet family paginates by rows_per_chunk, so paragraphsPerPage
  // was dropped at the mapping site and `page_aware` + 0 was silently accepted.
  it("rejects paragraphsPerPage = 0 for the spreadsheet family", async () => {
    const notAnXlsx = new Uint8Array([1, 2, 3, 4]);
    try {
      await getChunks(notAnXlsx, {
        filename: "x.xlsx",
        mode: "page_aware",
        paragraphsPerPage: 0,
      });
      expect.unreachable("expected getChunks to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ChunkError);
      expect((e as ChunkError).kind).toBe("invalid-arg");
      expect((e as ChunkError).message).toBe("paragraphs_per_page must be greater than 0");
    }
  });

  it("rejects an unsupported extension", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    await expect(getChunks(bytes, { filename: "data.xyz" })).rejects.toThrow();
  });

  it("throws ChunkError with kind 'unsupported' and the exact py-chunks message", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    try {
      await getChunks(bytes, { filename: "data.xyz" });
      expect.unreachable("expected getChunks to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ChunkError);
      const err = e as ChunkError;
      expect(err.name).toBe("ChunkError");
      expect(err.kind).toBe("unsupported");
      // Pins the ENGINE's message (unified across native/wasm in the 2026-08
      // dispatch cleanup). py-chunks raises the same prefix from its own layer
      // but appends ". Supported: [...]" — that suffix is Python-side, so exact
      // cross-SDK parity for THIS case is prefix-level, not byte-level.
      expect(err.message).toBe("Unsupported file type '.xyz'");
    }
  });

  it("throws ChunkError with kind 'invalid-arg' and the exact engine message", async () => {
    const bytes = fs.readFileSync(MD_PATH);
    try {
      await getChunks(bytes, {
        filename: "test.md",
        mode: "bogus" as unknown as import("../src/index.ts").ChunkMode,
      });
      expect.unreachable("expected getChunks to throw");
    } catch (e) {
      expect(e).toBeInstanceOf(ChunkError);
      const err = e as ChunkError;
      expect(err.kind).toBe("invalid-arg");
      // Pins the ENGINE's message verbatim. py-chunks validates modes in its
      // Python layer first, so its message differs cosmetically (single quotes,
      // sorted order) — parity for invalid-mode is kind+shape, not byte-level.
      expect(err.message).toBe(
        "mode must be one of [\"default\", \"structural\", \"section\", \"semantic\", \"sentence\", \"page_aware\", \"sliding_window\"] for MD, got: 'bogus'",
      );
    }
  });

  it("normalizePdfMarkdown returns a string", async () => {
    const out = await normalizePdfMarkdown("# Title\n\nSome text.");
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
  });

  it("streamChunks yields the same count as getChunks", async () => {
    const chunks = await getChunks(MD_PATH);
    let count = 0;
    const streamed: Chunk[] = [];
    for await (const c of streamChunks(MD_PATH)) {
      streamed.push(c);
      count++;
    }
    expect(count).toBe(chunks.length);
    expect(streamed[0]?.content).toBe(chunks[0]?.content);
  });

  function assertImages(images: ChunkImage[]) {
    expect(Array.isArray(images)).toBe(true);
    expect(images.length).toBeGreaterThan(0);
    for (const img of images) {
      expect(typeof img.name).toBe("string");
      expect(img.name.length).toBeGreaterThan(0);
      expect(img.data).toBeInstanceOf(Uint8Array);
      expect(img.data.length).toBeGreaterThan(0);
    }
  }

  it("getChunks with listImages returns { chunks, images }", async () => {
    const res = await getChunks(DOCX_IMG_PATH, { listImages: true });
    assertWellFormed(res.chunks);
    assertImages(res.images);
    // Every image should surface as an image chunk too.
    const imageChunks = res.chunks.filter((c) => c.contentType === "image");
    expect(imageChunks.length).toBe(res.images.length);
  });

  it("getMarkdown with listImages returns { markdown, images }", async () => {
    const res = await getMarkdown(DOCX_IMG_PATH, { listImages: true });
    expect(typeof res.markdown).toBe("string");
    expect(res.markdown.length).toBeGreaterThan(0);
    assertImages(res.images);
  });

  it("listImages on an image-less format yields an empty image list", async () => {
    const res = await getChunks(MD_PATH, { listImages: true });
    assertWellFormed(res.chunks);
    expect(res.images).toEqual([]);
  });

  it("chunkPdfMarkdown chunks host-supplied PDF markdown", async () => {
    const md = "# Title\n\nA first paragraph.\n\n---\n\n## Section\n\nMore text here.";
    const chunks = await chunkPdfMarkdown(md, 2);
    assertWellFormed(chunks);
    for (const c of chunks) {
      expect(c.metadata.document_metadata).toBeTypeOf("object");
    }
  });

  it("getChunks parses a real PDF via the wasm engine", async () => {
    const chunks = await getChunks(PDF_PATH);
    assertWellFormed(chunks);
  });

  it("getMarkdown on a PDF with listImages returns markdown + images", async () => {
    const res = await getMarkdown(PDF_PATH, { listImages: true });
    expect(typeof res.markdown).toBe("string");
    expect(res.markdown.length).toBeGreaterThan(0);
    // sample-pdf.pdf carries embedded images.
    assertImages(res.images);
  });
});
