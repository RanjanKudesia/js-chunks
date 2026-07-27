/**
 * chunks-js — idiomatic TypeScript wrapper around the WASM-backed
 * `rs-chunks` document chunking engine.
 *
 * Output matches the py-chunks / rs-chunks reference engine.
 *
 * The WASM artifact is produced separately (not by this package's build) via:
 *   wasm-pack build --target nodejs   -> pkg-node   (Node, default here)
 *   wasm-pack build --target web      -> pkg-web    (browser / Deno)
 *   wasm-pack build --target bundler  -> pkg        (bundlers)
 *
 * PDF is not compiled into the wasm engine (no PDFium). Instead a `.pdf` source
 * is parsed to Markdown host-side by the optional peer dependency
 * `@llamaindex/liteparse-wasm`, then fed to the engine's PDF-markdown chunker —
 * exactly mirroring how rs-chunks composes PDF markdown.
 */
export interface Chunk {
    content: string;
    contentType: string;
    metadata: Record<string, unknown>;
}
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
 * Stream chunks one at a time. Computes the full array (the engine is
 * synchronous), then yields each chunk — same results as {@link getChunks}.
 */
export declare function streamChunks(source: ChunkSource, opts?: ChunkOptions): AsyncGenerator<Chunk, void, unknown>;
/**
 * Chunk Markdown that was produced host-side for a PDF (e.g. by a separate PDF
 * parser). `totalPages` populates `document_metadata.total_pages`.
 */
export declare function chunkPdfMarkdown(markdown: string, totalPages: number, opts?: ChunkOptions): Promise<Chunk[]>;
//# sourceMappingURL=index.d.ts.map