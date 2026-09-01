/**
 * js-chunks — idiomatic TypeScript wrapper around the WASM-backed
 * `rs-chunks` document chunking engine.
 *
 * Output matches the py-chunks / rs-chunks reference engine.
 *
 * The WASM artifact is produced separately (not by this package's build) via:
 *   wasm-pack build --target nodejs   -> pkg-node   (Node, default here)
 *   wasm-pack build --target web      -> pkg-web    (browser / Deno / bundlers via the "js-chunks/web" subpath)
 *
 * PDF is parsed by the engine itself, in wasm, exactly as py-chunks and
 * rs-chunks parse it — there is no host-side PDF parser and no optional peer
 * dependency any more. The one thing wasm cannot do is *render* a page, so a
 * scanned PDF with no extractable text reports that rather than returning page
 * rasters (see the PDF notes in the README).
 */
export interface Chunk {
    content: string;
    contentType: string;
    metadata: Record<string, unknown>;
}
export { ChunkError, type ChunkErrorKind } from "./errors.js";
export { fitTokens } from "./fit.js";
export type { FitMerge, FitMergeMetadata, FitOptions, FitOversize, FitSplit, TokenCounter, } from "./fit.js";
/** An extracted embedded image: its markdown reference name and raw bytes. */
export interface ChunkImage {
    name: string;
    data: Uint8Array;
}
export interface ChunksWithImages {
    chunks: Chunk[];
    images: ChunkImage[];
}
export interface MarkdownWithImages {
    markdown: string;
    images: ChunkImage[];
}
export type ChunkMode = "default" | "section" | "semantic" | "sentence" | "page_aware" | "sliding_window" | "row" | "table" | "sheet" | "structural";
export interface ChunkOptions {
    mode?: ChunkMode;
    windowSize?: number;
    overlap?: number;
    sentencesPerChunk?: number;
    paragraphsPerPage?: number;
    /** Required when `source` is raw bytes and carries no name of its own. */
    filename?: string;
    /** Return extracted embedded images alongside the result (py-chunks `list_images=True`). */
    listImages?: boolean;
}
/** A byte-like source that can be normalized to `Uint8Array`. */
export type ByteSource = Uint8Array | ArrayBuffer | Blob;
/**
 * A chunking source. May be:
 *  - a filesystem path (Node only) — filename is derived from it
 *  - a `Uint8Array`, `ArrayBuffer`, Node `Buffer`, or `Blob` — needs a filename
 */
export type ChunkSource = string | ByteSource;
/**
 * Chunk a document. `source` may be a filesystem path (Node), `Uint8Array`,
 * `ArrayBuffer`, Node `Buffer`, or `Blob`. When bytes are passed, provide a
 * filename via `opts.filename` (or a named `Blob`) for extension routing.
 *
 * With `listImages: true`, resolves to `{ chunks, images }`.
 */
export declare function getChunks(source: ChunkSource, opts?: ChunkOptions & {
    listImages?: false;
}): Promise<Chunk[]>;
export declare function getChunks(source: ChunkSource, opts: ChunkOptions & {
    listImages: true;
}): Promise<ChunksWithImages>;
/**
 * Convert a document to Markdown. Same source rules as {@link getChunks}.
 * With `listImages: true`, resolves to `{ markdown, images }`.
 */
export declare function getMarkdown(source: ChunkSource, opts?: ChunkOptions & {
    listImages?: false;
}): Promise<string>;
export declare function getMarkdown(source: ChunkSource, opts: ChunkOptions & {
    listImages: true;
}): Promise<MarkdownWithImages>;
/**
 * Yield chunks one at a time as an `AsyncGenerator`.
 *
 * **This is an ergonomic wrapper, not incremental streaming.** The wasm
 * boundary is a synchronous full-parse: this computes the complete array via
 * {@link getChunks} and *then* yields its elements. Results are identical to
 * {@link getChunks}, and so is peak memory — the whole document and the whole
 * chunk list are in memory before the first `yield`. Use it for `for await`
 * ergonomics and for interleaving downstream work with iteration, not to
 * bound memory on a large file.
 *
 * (`rs-chunks` and `py-chunks` do have truly incremental streaming for some
 * formats; wasm does not — see the README.)
 */
export declare function streamChunks(source: ChunkSource, opts?: ChunkOptions): AsyncGenerator<Chunk, void, unknown>;
/**
 * Chunk Markdown that some *other* PDF parser produced. `.pdf` input is parsed
 * by the engine itself — this is for callers who already have markdown of their
 * own and want it chunked the same way. `totalPages` populates
 * `document_metadata.total_pages`.
 */
export declare function chunkPdfMarkdown(markdown: string, totalPages: number, opts?: ChunkOptions): Promise<Chunk[]>;
/**
 * Like {@link chunkPdfMarkdown}, but with host-supplied PDF images: `images`
 * entries are `{ name, data }` where `name` matches the `![](name)` reference
 * in the markdown. Resolves to `{ chunks, images }` with image chunks first —
 * the same shape `getChunks(..., { listImages: true })` returns.
 *
 * `.pdf` input is parsed (images included) by the engine itself — this exists
 * for callers who parsed the PDF with some other tool and want identical
 * chunking. It is also what the chunkengine.dev playground drives.
 */
export declare function chunkPdfMarkdownWithImages(markdown: string, images: ChunkImage[], totalPages: number, opts?: ChunkOptions): Promise<ChunksWithImages>;
/**
 * Apply the engine's PDF-markdown normalisation (author-block handling, etc.)
 * to markdown a *host-side* PDF parser produced. {@link chunkPdfMarkdown}
 * already normalises internally; use this when you need the normalised
 * markdown string itself to match what `getMarkdown` would emit.
 */
export declare function normalizePdfMarkdown(markdown: string): Promise<string>;
//# sourceMappingURL=index.d.ts.map