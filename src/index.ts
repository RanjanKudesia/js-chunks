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

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface Chunk {
  content: string;
  contentType: string;
  metadata: Record<string, unknown>;
}

/**
 * The engine error variant, carried across the wasm boundary out-of-band so the
 * message itself can stay byte-identical to what py-chunks raises:
 *  - `"unsupported"` — unsupported extension / capability (py-chunks `ValueError`)
 *  - `"invalid-arg"` — bad mode or parameter (py-chunks `ValueError`)
 *  - `"parse"`       — the document failed to parse (py-chunks `RuntimeError`)
 *  - `"io"`          — an I/O failure inside the engine
 *  - `"unknown"`     — an error that carried no recognised variant tag
 */
export type ChunkErrorKind = "unsupported" | "invalid-arg" | "parse" | "io" | "unknown";

const CHUNK_ERROR_KINDS: ReadonlySet<string> = new Set([
  "unsupported",
  "invalid-arg",
  "parse",
  "io",
  "unknown",
]);

/**
 * Error thrown for every engine failure. `message` is byte-identical to the
 * message py-chunks raises for the same input (the cross-SDK parity contract);
 * `kind` restores the variant that py-chunks expresses as an exception *type*.
 */
export class ChunkError extends Error {
  readonly kind: ChunkErrorKind;

  constructor(message: string, kind: ChunkErrorKind) {
    super(message);
    this.name = "ChunkError";
    this.kind = kind;
  }
}

/** Normalize whatever the wasm boundary threw into a ChunkError. */
function toChunkError(e: unknown): ChunkError {
  if (e instanceof ChunkError) return e;
  if (typeof e === "string") return new ChunkError(e, "unknown");
  if (e instanceof Error || (typeof e === "object" && e !== null && "message" in e)) {
    const message = String((e as { message: unknown }).message);
    const rawKind = (e as { kind?: unknown }).kind;
    const kind: ChunkErrorKind =
      typeof rawKind === "string" && CHUNK_ERROR_KINDS.has(rawKind)
        ? (rawKind as ChunkErrorKind)
        : "unknown";
    return new ChunkError(message, kind);
  }
  return new ChunkError(String(e), "unknown");
}

/** Run a wasm call, rethrowing any failure as a typed {@link ChunkError}. */
function wrapWasm<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    throw toChunkError(e);
  }
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
  normalizePdfMarkdown: (markdown: string) => string;
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
    // Browser / Deno (unbundled): the web build exposes a default `init()` that
    // instantiates the wasm, plus the named exports.
    //
    // KNOWN LIMITATION — bundlers: `@vite-ignore` deliberately hides this
    // dynamic import from bundlers (vite/webpack/rollup), so a *bundled*
    // browser app neither bundles the glue nor copies chunks_wasm_bg.wasm,
    // and this path 404s at runtime. Bundled apps must import the web build
    // explicitly via the `js-chunks/web` subpath export and serve the .wasm
    // asset — see "Bundlers (vite/webpack)" in the README. This auto-loader
    // works as-is only where the specifier resolves at runtime (Node, Deno,
    // unbundled browser ESM).
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
  const wasm = await loadWasm();

  if (opts.listImages) {
    const raw = wrapWasm(() =>
      wasm.getChunksWithImages(
        data,
        filename,
        o.mode,
        o.windowSize,
        o.overlap,
        o.sentencesPerChunk,
        o.paragraphsPerPage,
      ),
    );
    return { chunks: (raw.chunks ?? []).map(mapChunk), images: (raw.images ?? []).map(mapImage) };
  }

  const raw = wrapWasm(() =>
    wasm.getChunks(
      data,
      filename,
      o.mode,
      o.windowSize,
      o.overlap,
      o.sentencesPerChunk,
      o.paragraphsPerPage,
    ),
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
  const wasm = await loadWasm();

  if (opts.listImages) {
    const raw = wrapWasm(() => wasm.getMarkdownWithImages(data, filename));
    return { markdown: raw.markdown, images: (raw.images ?? []).map(mapImage) };
  }
  return wrapWasm(() => wasm.getMarkdown(data, filename));
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
 * Chunk Markdown that some *other* PDF parser produced. `.pdf` input is parsed
 * by the engine itself — this is for callers who already have markdown of their
 * own and want it chunked the same way. `totalPages` populates
 * `document_metadata.total_pages`.
 */
export async function chunkPdfMarkdown(
  markdown: string,
  totalPages: number,
  opts: ChunkOptions = {},
): Promise<Chunk[]> {
  const o = resolveOpts(opts);
  const wasm = await loadWasm();
  const raw = wrapWasm(() =>
    wasm.chunkPdfMarkdown(
      markdown,
      totalPages,
      o.mode,
      o.windowSize,
      o.overlap,
      o.sentencesPerChunk,
      o.paragraphsPerPage,
    ),
  );
  return (raw ?? []).map(mapChunk);
}

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
export async function chunkPdfMarkdownWithImages(
  markdown: string,
  images: ChunkImage[],
  totalPages: number,
  opts: ChunkOptions = {},
): Promise<ChunksWithImages> {
  const o = resolveOpts(opts);
  const wasm = await loadWasm();
  const raw = wrapWasm(() =>
    wasm.chunkPdfMarkdownWithImages(
      markdown,
      images,
      totalPages,
      o.mode,
      o.windowSize,
      o.overlap,
      o.sentencesPerChunk,
      o.paragraphsPerPage,
    ),
  );
  return { chunks: (raw.chunks ?? []).map(mapChunk), images: (raw.images ?? []).map(mapImage) };
}

/**
 * Apply the engine's PDF-markdown normalisation (author-block handling, etc.)
 * to markdown a *host-side* PDF parser produced. {@link chunkPdfMarkdown}
 * already normalises internally; use this when you need the normalised
 * markdown string itself to match what `getMarkdown` would emit.
 */
export async function normalizePdfMarkdown(markdown: string): Promise<string> {
  const wasm = await loadWasm();
  return wrapWasm(() => wasm.normalizePdfMarkdown(markdown));
}
