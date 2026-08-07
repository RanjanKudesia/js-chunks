import { describe, it, expect, beforeAll } from "vitest";
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
