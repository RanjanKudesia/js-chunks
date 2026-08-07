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
const CHUNK_ERROR_KINDS = new Set([
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
    kind;
    constructor(message, kind) {
        super(message);
        this.name = "ChunkError";
        this.kind = kind;
    }
}
/** Normalize whatever the wasm boundary threw into a ChunkError. */
function toChunkError(e) {
    if (e instanceof ChunkError)
        return e;
    if (typeof e === "string")
        return new ChunkError(e, "unknown");
    if (e instanceof Error || (typeof e === "object" && e !== null && "message" in e)) {
        const message = String(e.message);
        const rawKind = e.kind;
        const kind = typeof rawKind === "string" && CHUNK_ERROR_KINDS.has(rawKind)
            ? rawKind
            : "unknown";
        return new ChunkError(message, kind);
    }
    return new ChunkError(String(e), "unknown");
}
/** Run a wasm call, rethrowing any failure as a typed {@link ChunkError}. */
function wrapWasm(fn) {
    try {
        return fn();
    }
    catch (e) {
        throw toChunkError(e);
    }
}
const DEFAULTS = {
    mode: "default",
    windowSize: 3,
    overlap: 1,
    sentencesPerChunk: 3,
    paragraphsPerPage: 15,
};
let _wasm;
let _wasmPromise;
const isNode = typeof process !== "undefined" &&
    process.versions != null &&
    process.versions.node != null &&
    // Deno also defines `process` in recent versions; exclude it.
    typeof globalThis.Deno === "undefined";
/**
 * Load the wasm engine. On Node the synchronous CommonJS `pkg-node` build is
 * used (fast, no async init). On browsers / Deno / bundlers, the `pkg-web`
 * build is instantiated asynchronously. Cached after first load.
 */
async function loadWasm() {
    if (_wasm)
        return _wasm;
    if (_wasmPromise)
        return _wasmPromise;
    _wasmPromise = (async () => {
        if (isNode) {
            // pkg-node ships CJS that instantiates the wasm synchronously on require.
            const { createRequire } = await import("node:module");
            const require = createRequire(import.meta.url);
            _wasm = require("../pkg-node/chunks_wasm.js");
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
        /* @vite-ignore */ "../pkg-web/chunks_wasm.js"));
        if (typeof mod.default === "function") {
            await mod.default();
        }
        _wasm = mod;
        return mod;
    })();
    return _wasmPromise;
}
function basename(p) {
    const norm = p.replace(/\\/g, "/");
    const idx = norm.lastIndexOf("/");
    return idx >= 0 ? norm.slice(idx + 1) : norm;
}
function isArrayBuffer(v) {
    return (typeof ArrayBuffer !== "undefined" &&
        (v instanceof ArrayBuffer ||
            Object.prototype.toString.call(v) === "[object ArrayBuffer]"));
}
function isBlob(v) {
    return typeof Blob !== "undefined" && v instanceof Blob;
}
async function normalizeSource(source, opts) {
    // Filesystem path (Node only).
    if (typeof source === "string") {
        if (!isNode) {
            throw new Error("Filesystem paths are only supported on Node. Pass a Uint8Array/ArrayBuffer/Blob with opts.filename instead.");
        }
        const { createRequire } = await import("node:module");
        const require = createRequire(import.meta.url);
        const fs = require("node:fs");
        const data = new Uint8Array(fs.readFileSync(source));
        const filename = opts.filename ?? basename(source);
        return { data, filename };
    }
    // Blob (may carry a name).
    if (isBlob(source)) {
        const data = new Uint8Array(await source.arrayBuffer());
        const blobName = opts.filename ??
            (typeof source.name === "string"
                ? source.name
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
    throw new TypeError("Unsupported source: expected a string path, Uint8Array, ArrayBuffer, Buffer, or Blob.");
}
function requireFilename(name) {
    if (!name) {
        throw new Error("A filename is required for byte sources (pass opts.filename or a named Blob) so the engine can route by extension.");
    }
    return name;
}
function mapChunk(raw) {
    return {
        content: raw.content,
        contentType: raw.content_type,
        // metadata is already a plain object — pass through untouched.
        metadata: raw.metadata ?? {},
    };
}
function mapImage(raw) {
    return { name: raw.name, data: raw.data };
}
function resolveOpts(opts) {
    return {
        mode: opts.mode ?? DEFAULTS.mode,
        windowSize: opts.windowSize ?? DEFAULTS.windowSize,
        overlap: opts.overlap ?? DEFAULTS.overlap,
        sentencesPerChunk: opts.sentencesPerChunk ?? DEFAULTS.sentencesPerChunk,
        paragraphsPerPage: opts.paragraphsPerPage ?? DEFAULTS.paragraphsPerPage,
    };
}
export async function getChunks(source, opts = {}) {
    const { data, filename } = await normalizeSource(source, opts);
    const o = resolveOpts(opts);
    const wasm = await loadWasm();
    if (opts.listImages) {
        const raw = wrapWasm(() => wasm.getChunksWithImages(data, filename, o.mode, o.windowSize, o.overlap, o.sentencesPerChunk, o.paragraphsPerPage));
        return { chunks: (raw.chunks ?? []).map(mapChunk), images: (raw.images ?? []).map(mapImage) };
    }
    const raw = wrapWasm(() => wasm.getChunks(data, filename, o.mode, o.windowSize, o.overlap, o.sentencesPerChunk, o.paragraphsPerPage));
    return (raw ?? []).map(mapChunk);
}
export async function getMarkdown(source, opts = {}) {
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
export async function* streamChunks(source, opts = {}) {
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
export async function chunkPdfMarkdown(markdown, totalPages, opts = {}) {
    const o = resolveOpts(opts);
    const wasm = await loadWasm();
    const raw = wrapWasm(() => wasm.chunkPdfMarkdown(markdown, totalPages, o.mode, o.windowSize, o.overlap, o.sentencesPerChunk, o.paragraphsPerPage));
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
export async function chunkPdfMarkdownWithImages(markdown, images, totalPages, opts = {}) {
    const o = resolveOpts(opts);
    const wasm = await loadWasm();
    const raw = wrapWasm(() => wasm.chunkPdfMarkdownWithImages(markdown, images, totalPages, o.mode, o.windowSize, o.overlap, o.sentencesPerChunk, o.paragraphsPerPage));
    return { chunks: (raw.chunks ?? []).map(mapChunk), images: (raw.images ?? []).map(mapImage) };
}
/**
 * Apply the engine's PDF-markdown normalisation (author-block handling, etc.)
 * to markdown a *host-side* PDF parser produced. {@link chunkPdfMarkdown}
 * already normalises internally; use this when you need the normalised
 * markdown string itself to match what `getMarkdown` would emit.
 */
export async function normalizePdfMarkdown(markdown) {
    const wasm = await loadWasm();
    return wrapWasm(() => wasm.normalizePdfMarkdown(markdown));
}
//# sourceMappingURL=index.js.map