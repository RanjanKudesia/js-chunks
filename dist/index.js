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
        // Browser / Deno / bundler: the web build exposes a default `init()` that
        // instantiates the wasm, plus the named exports.
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
function extOf(filename) {
    const base = basename(filename);
    const dot = base.lastIndexOf(".");
    return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
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
let _liteparse;
async function loadLiteParse() {
    if (_liteparse)
        return _liteparse;
    let mod;
    try {
        mod = (await import(
        /* @vite-ignore */ "@llamaindex/liteparse-wasm"));
    }
    catch {
        throw new Error("PDF support requires the optional peer dependency '@llamaindex/liteparse-wasm'. " +
            "Install it with: npm install @llamaindex/liteparse-wasm");
    }
    if (typeof mod.default === "function") {
        try {
            // Browser / bundler / Deno: instantiate by fetching the bundled wasm.
            await mod.default();
        }
        catch {
            // Node fallback: the web build cannot fetch; feed the wasm bytes directly.
            const { createRequire } = await import("node:module");
            const require = createRequire(import.meta.url);
            const wasmPath = require.resolve("@llamaindex/liteparse-wasm/liteparse_wasm_bg.wasm");
            const fs = require("node:fs");
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
async function pdfToMarkdown(data, embedImages) {
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
    const images = embedImages
        ? result.images.map((img) => ({
            name: `image_${img.id}.png`,
            data: img.bytes instanceof Uint8Array ? img.bytes : new Uint8Array(img.bytes),
        }))
        : [];
    return { markdown, totalPages, images };
}
export async function getChunks(source, opts = {}) {
    const { data, filename } = await normalizeSource(source, opts);
    const o = resolveOpts(opts);
    const ext = extOf(filename);
    const wasm = await loadWasm();
    if (ext === "pdf") {
        const conv = await pdfToMarkdown(data, opts.listImages === true);
        if (opts.listImages) {
            const raw = wasm.chunkPdfMarkdownWithImages(conv.markdown, conv.images.map((i) => ({ name: i.name, data: i.data })), conv.totalPages, o.mode, o.windowSize, o.overlap, o.sentencesPerChunk, o.paragraphsPerPage);
            return { chunks: (raw.chunks ?? []).map(mapChunk), images: (raw.images ?? []).map(mapImage) };
        }
        const raw = wasm.chunkPdfMarkdown(conv.markdown, conv.totalPages, o.mode, o.windowSize, o.overlap, o.sentencesPerChunk, o.paragraphsPerPage);
        return (raw ?? []).map(mapChunk);
    }
    if (opts.listImages) {
        const raw = wasm.getChunksWithImages(data, filename, o.mode, o.windowSize, o.overlap, o.sentencesPerChunk, o.paragraphsPerPage);
        return { chunks: (raw.chunks ?? []).map(mapChunk), images: (raw.images ?? []).map(mapImage) };
    }
    const raw = wasm.getChunks(data, filename, o.mode, o.windowSize, o.overlap, o.sentencesPerChunk, o.paragraphsPerPage);
    return (raw ?? []).map(mapChunk);
}
export async function getMarkdown(source, opts = {}) {
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
export async function* streamChunks(source, opts = {}) {
    const chunks = await getChunks(source, { ...opts, listImages: false });
    for (const chunk of chunks) {
        yield chunk;
    }
}
/**
 * Chunk Markdown that was produced host-side for a PDF (e.g. by a separate PDF
 * parser). `totalPages` populates `document_metadata.total_pages`.
 */
export async function chunkPdfMarkdown(markdown, totalPages, opts = {}) {
    const o = resolveOpts(opts);
    const wasm = await loadWasm();
    const raw = wasm.chunkPdfMarkdown(markdown, totalPages, o.mode, o.windowSize, o.overlap, o.sentencesPerChunk, o.paragraphsPerPage);
    return (raw ?? []).map(mapChunk);
}
//# sourceMappingURL=index.js.map