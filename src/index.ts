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

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

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

export type ChunkMode =
  | "default"
  | "section"
  | "semantic"
  | "sentence"
  | "page_aware"
  | "sliding_window"
  | "row"
  | "table"
  | "sheet"
  | "structural";

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

const DEFAULTS: Required<Omit<ChunkOptions, "filename" | "listImages">> = {
  mode: "default",
  windowSize: 3,
  overlap: 1,
  sentencesPerChunk: 3,
  paragraphsPerPage: 15,
};

// ---------------------------------------------------------------------------
// WASM module loading (runtime-aware)
// ---------------------------------------------------------------------------

interface RawImage {
  name: string;
  data: Uint8Array;
}

interface RawChunksWithImages {
  chunks: RawChunk[];
  images: RawImage[];
}

interface RawMarkdownWithImages {
  markdown: string;
  images: RawImage[];
}

interface WasmModule {
  getChunks: (
    data: Uint8Array,
    filename: string,
    mode: string,
    windowSize: number,
    overlap: number,
    sentencesPerChunk: number,
    paragraphsPerPage: number,
  ) => RawChunk[];
  getMarkdown: (data: Uint8Array, filename: string) => string;
  getChunksWithImages: (
    data: Uint8Array,
    filename: string,
    mode: string,
    windowSize: number,
    overlap: number,
    sentencesPerChunk: number,
    paragraphsPerPage: number,
  ) => RawChunksWithImages;
  getMarkdownWithImages: (data: Uint8Array, filename: string) => RawMarkdownWithImages;
  chunkPdfMarkdown: (
    markdown: string,
    totalPages: number,
    mode: string,
    windowSize: number,
    overlap: number,
    sentencesPerChunk: number,
    paragraphsPerPage: number,
  ) => RawChunk[];
  chunkPdfMarkdownWithImages: (
    markdown: string,
    images: RawImage[],
    totalPages: number,
    mode: string,
    windowSize: number,
    overlap: number,
    sentencesPerChunk: number,
    paragraphsPerPage: number,
  ) => RawChunksWithImages;
}

interface RawChunk {
  content: string;
  content_type: string;
  metadata: Record<string, unknown>;
}

let _wasm: WasmModule | undefined;
let _wasmPromise: Promise<WasmModule> | undefined;

const isNode =
  typeof process !== "undefined" &&
  process.versions != null &&
  process.versions.node != null &&
  // Deno also defines `process` in recent versions; exclude it.
  typeof (globalThis as { Deno?: unknown }).Deno === "undefined";

/**
 * Load the wasm engine. On Node the synchronous CommonJS `pkg-node` build is
 * used (fast, no async init). On browsers / Deno / bundlers, the `pkg-web`
 * build is instantiated asynchronously. Cached after first load.
 */
async function loadWasm(): Promise<WasmModule> {
  if (_wasm) return _wasm;
  if (_wasmPromise) return _wasmPromise;

  _wasmPromise = (async () => {
    if (isNode) {
      // pkg-node ships CJS that instantiates the wasm synchronously on require.
      const { createRequire } = await import("node:module");
      const require = createRequire(import.meta.url);
      _wasm = require("../pkg-node/chunks_wasm.js") as WasmModule;
      return _wasm;
    }
    // Browser / Deno / bundler: the web build exposes a default `init()` that
    // instantiates the wasm, plus the named exports.
    const mod = (await import(
      /* @vite-ignore */ "../pkg-web/chunks_wasm.js"
    )) as unknown as WasmModule & { default: (arg?: unknown) => Promise<unknown> };
    if (typeof mod.default === "function") {
      await mod.default();
    }
    _wasm = mod;
    return mod;
  })();

  return _wasmPromise;
}

// ---------------------------------------------------------------------------
// Source normalization
// ---------------------------------------------------------------------------

interface Normalized {
  data: Uint8Array;
  filename: string;
}

function basename(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

function extOf(filename: string): string {
  const base = basename(filename);
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

function isArrayBuffer(v: unknown): v is ArrayBuffer {
  return (
    typeof ArrayBuffer !== "undefined" &&
    (v instanceof ArrayBuffer ||
      Object.prototype.toString.call(v) === "[object ArrayBuffer]")
  );
}

function isBlob(v: unknown): v is Blob {
  return typeof Blob !== "undefined" && v instanceof Blob;
}

async function normalizeSource(
  source: ChunkSource,
  opts: ChunkOptions,
): Promise<Normalized> {
  // Filesystem path (Node only).
  if (typeof source === "string") {
    if (!isNode) {
      throw new Error(
        "Filesystem paths are only supported on Node. Pass a Uint8Array/ArrayBuffer/Blob with opts.filename instead.",
      );
    }
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    const fs = require("node:fs") as typeof import("node:fs");
    const data = new Uint8Array(fs.readFileSync(source));
    const filename = opts.filename ?? basename(source);
    return { data, filename };
  }

  // Blob (may carry a name).
  if (isBlob(source)) {
    const data = new Uint8Array(await source.arrayBuffer());
    const blobName =
      opts.filename ??
      (typeof (source as Blob & { name?: string }).name === "string"
        ? (source as Blob & { name?: string }).name
        : undefined);
    const filename = requireFilename(blobName);
    return { data, filename };
  }

  // ArrayBuffer.
  if (isArrayBuffer(source)) {
    const data = new Uint8Array(source);
    return { data, filename: requireFilename(opts.filename) };
  }

  // Uint8Array / Node Buffer (Buffer is a Uint8Array subclass).
  if (source instanceof Uint8Array) {
    return { data: source, filename: requireFilename(opts.filename) };
  }

  throw new TypeError(
    "Unsupported source: expected a string path, Uint8Array, ArrayBuffer, Buffer, or Blob.",
  );
}

function requireFilename(name: string | undefined): string {
  if (!name) {
    throw new Error(
      "A filename is required for byte sources (pass opts.filename or a named Blob) so the engine can route by extension.",
    );
  }
  return name;
}

function mapChunk(raw: RawChunk): Chunk {
  return {
    content: raw.content,
    contentType: raw.content_type,
    // metadata is already a plain object — pass through untouched.
    metadata: raw.metadata ?? {},
  };
}

function mapImage(raw: RawImage): ChunkImage {
  return { name: raw.name, data: raw.data };
}

function resolveOpts(
  opts: ChunkOptions,
): Required<Omit<ChunkOptions, "filename" | "listImages">> {
  return {
    mode: opts.mode ?? DEFAULTS.mode,
    windowSize: opts.windowSize ?? DEFAULTS.windowSize,
    overlap: opts.overlap ?? DEFAULTS.overlap,
    sentencesPerChunk: opts.sentencesPerChunk ?? DEFAULTS.sentencesPerChunk,
    paragraphsPerPage: opts.paragraphsPerPage ?? DEFAULTS.paragraphsPerPage,
  };
}

// ---------------------------------------------------------------------------
// PDF host-side conversion (@llamaindex/liteparse-wasm)
// ---------------------------------------------------------------------------

interface PdfConversion {
  markdown: string;
  totalPages: number;
  images: ChunkImage[];
}

// Minimal structural view of the liteparse-wasm API we depend on.
interface LiteParseModule {
  default?: (arg?: unknown) => Promise<unknown>;
  LiteParse: new (config: Record<string, unknown>) => {
    parse: (data: Uint8Array) => Promise<{
      pages: { markdown: string }[];
      images: { id: string; bytes: number[] | Uint8Array }[];
    }>;
  };
}

let _liteparse: LiteParseModule | undefined;

async function loadLiteParse(): Promise<LiteParseModule> {
  if (_liteparse) return _liteparse;
  let mod: LiteParseModule;
  try {
    mod = (await import(
      /* @vite-ignore */ "@llamaindex/liteparse-wasm"
    )) as unknown as LiteParseModule;
  } catch {
    throw new Error(
      "PDF support requires the optional peer dependency '@llamaindex/liteparse-wasm'. " +
        "Install it with: npm install @llamaindex/liteparse-wasm",
    );
  }
  if (typeof mod.default === "function") {
    try {
      // Browser / bundler / Deno: instantiate by fetching the bundled wasm.
      await mod.default();
    } catch {
      // Node fallback: the web build cannot fetch; feed the wasm bytes directly.
      const { createRequire } = await import("node:module");
      const require = createRequire(import.meta.url);
      const wasmPath = require.resolve(
        "@llamaindex/liteparse-wasm/liteparse_wasm_bg.wasm",
      );
      const fs = require("node:fs") as typeof import("node:fs");
      const bytes = new Uint8Array(fs.readFileSync(wasmPath));
      await mod.default({ module_or_path: bytes });
    }
  }
  _liteparse = mod;
  return mod;
}

/**
 * Parse a PDF's bytes to Markdown, mirroring rs-chunks' liteparse composition:
 * pages' markdown are `trimEnd`ed, empties dropped, and joined by `\n\n---\n\n`.
 * Images (when requested) are keyed `image_{id}.png` to match the `![](…)` refs.
 */
async function pdfToMarkdown(
  data: Uint8Array,
  embedImages: boolean,
): Promise<PdfConversion> {
  const mod = await loadLiteParse();
  const parser = new mod.LiteParse({
    ocrEnabled: false,
    outputFormat: "markdown",
    imageMode: embedImages ? "embed" : "placeholder",
    quiet: true,
  });
  const result = await parser.parse(data);
  const totalPages = result.pages.length;
  const markdown = result.pages
    .map((p) => p.markdown.trimEnd())
    .filter((m) => m !== "")
    .join("\n\n---\n\n");
  const images: ChunkImage[] = embedImages
    ? result.images.map((img) => ({
        name: `image_${img.id}.png`,
        data: img.bytes instanceof Uint8Array ? img.bytes : new Uint8Array(img.bytes),
      }))
    : [];
  return { markdown, totalPages, images };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Chunk a document. `source` may be a filesystem path (Node), `Uint8Array`,
 * `ArrayBuffer`, Node `Buffer`, or `Blob`. When bytes are passed, provide a
 * filename via `opts.filename` (or a named `Blob`) for extension routing.
 *
 * With `listImages: true`, resolves to `{ chunks, images }`.
 */
export async function getChunks(
  source: ChunkSource,
  opts?: ChunkOptions & { listImages?: false },
): Promise<Chunk[]>;
export async function getChunks(
  source: ChunkSource,
  opts: ChunkOptions & { listImages: true },
): Promise<ChunksWithImages>;
export async function getChunks(
  source: ChunkSource,
  opts: ChunkOptions = {},
): Promise<Chunk[] | ChunksWithImages> {
  const { data, filename } = await normalizeSource(source, opts);
  const o = resolveOpts(opts);
  const ext = extOf(filename);
  const wasm = await loadWasm();

  if (ext === "pdf") {
    const conv = await pdfToMarkdown(data, opts.listImages === true);
    if (opts.listImages) {
      const raw = wasm.chunkPdfMarkdownWithImages(
        conv.markdown,
        conv.images.map((i) => ({ name: i.name, data: i.data })),
        conv.totalPages,
        o.mode,
        o.windowSize,
        o.overlap,
        o.sentencesPerChunk,
        o.paragraphsPerPage,
      );
      return { chunks: (raw.chunks ?? []).map(mapChunk), images: (raw.images ?? []).map(mapImage) };
    }
    const raw = wasm.chunkPdfMarkdown(
      conv.markdown,
      conv.totalPages,
      o.mode,
      o.windowSize,
      o.overlap,
      o.sentencesPerChunk,
      o.paragraphsPerPage,
    );
    return (raw ?? []).map(mapChunk);
  }

  if (opts.listImages) {
    const raw = wasm.getChunksWithImages(
      data,
      filename,
      o.mode,
      o.windowSize,
      o.overlap,
      o.sentencesPerChunk,
      o.paragraphsPerPage,
    );
    return { chunks: (raw.chunks ?? []).map(mapChunk), images: (raw.images ?? []).map(mapImage) };
  }

  const raw = wasm.getChunks(
    data,
    filename,
    o.mode,
    o.windowSize,
    o.overlap,
    o.sentencesPerChunk,
    o.paragraphsPerPage,
  );
  return (raw ?? []).map(mapChunk);
}

/**
 * Convert a document to Markdown. Same source rules as {@link getChunks}.
 * With `listImages: true`, resolves to `{ markdown, images }`.
 */
export async function getMarkdown(
  source: ChunkSource,
  opts?: ChunkOptions & { listImages?: false },
): Promise<string>;
export async function getMarkdown(
  source: ChunkSource,
  opts: ChunkOptions & { listImages: true },
): Promise<MarkdownWithImages>;
export async function getMarkdown(
  source: ChunkSource,
  opts: ChunkOptions = {},
): Promise<string | MarkdownWithImages> {
  const { data, filename } = await normalizeSource(source, opts);
  const ext = extOf(filename);
  const wasm = await loadWasm();

  if (ext === "pdf") {
    const conv = await pdfToMarkdown(data, opts.listImages === true);
    return opts.listImages ? { markdown: conv.markdown, images: conv.images } : conv.markdown;
  }

  if (opts.listImages) {
    const raw = wasm.getMarkdownWithImages(data, filename);
    return { markdown: raw.markdown, images: (raw.images ?? []).map(mapImage) };
  }
  return wasm.getMarkdown(data, filename);
}

/**
 * Stream chunks one at a time. Computes the full array (the engine is
 * synchronous), then yields each chunk — same results as {@link getChunks}.
 */
export async function* streamChunks(
  source: ChunkSource,
  opts: ChunkOptions = {},
): AsyncGenerator<Chunk, void, unknown> {
  const chunks = await getChunks(source, { ...opts, listImages: false });
  for (const chunk of chunks) {
    yield chunk;
  }
}

/**
 * Chunk Markdown that was produced host-side for a PDF (e.g. by a separate PDF
 * parser). `totalPages` populates `document_metadata.total_pages`.
 */
export async function chunkPdfMarkdown(
  markdown: string,
  totalPages: number,
  opts: ChunkOptions = {},
): Promise<Chunk[]> {
  const o = resolveOpts(opts);
  const wasm = await loadWasm();
  const raw = wasm.chunkPdfMarkdown(
    markdown,
    totalPages,
    o.mode,
    o.windowSize,
    o.overlap,
    o.sentencesPerChunk,
    o.paragraphsPerPage,
  );
  return (raw ?? []).map(mapChunk);
}
