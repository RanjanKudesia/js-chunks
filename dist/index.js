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
// The error contract lives in `errors.ts` so pure host-side helpers (fitTokens)
// can throw the same `ChunkError` without importing this wasm-backed module.
// Re-exported here because this is the public entry point.
export { ChunkError } from "./errors.js";
import { ChunkError, wrapWasm } from "./errors.js";
// The token-budget helper: pure TypeScript, no wasm, deliberately parity-exempt.
export { fitTokens } from "./fit.js";
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
            throw new ChunkError("Filesystem paths are only supported on Node. Pass a Uint8Array/ArrayBuffer/Blob with opts.filename instead.", "invalid-arg");
        }
        const { createRequire } = await import("node:module");
        const require = createRequire(import.meta.url);
        const fs = require("node:fs");
        // A missing or unreadable path used to escape as Node's own Error, so
        // `catch (e) { if (e instanceof ChunkError) }` silently missed the single
        // most common failure. `io` is the kind the engine uses for the same
        // condition when it reads the file itself.
        let bytes;
        try {
            bytes = fs.readFileSync(source);
        }
        catch (e) {
            throw new ChunkError(e instanceof Error ? e.message : String(e), "io");
        }
        const data = new Uint8Array(bytes);
        const filename = opts.filename ?? basename(source);
        return { data, filename };
    }
    // Blob (may carry a name).
    if (isBlob(source)) {
        return normalizeBlob(source, opts);
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
    throw new ChunkError("Unsupported source: expected a string path, Uint8Array, ArrayBuffer, Buffer, or Blob.", "invalid-arg");
}
/**
 * Read a Blob's bytes and its optional `name`.
 *
 * Both reads are caller-controlled code: `Blob` is subclassable, so
 * `arrayBuffer()` can reject and a `name` getter can throw. Either used to
 * escape as whatever it threw, breaking `catch (e) { if (e instanceof
 * ChunkError) }`. Failing to read the source's bytes is the same condition the
 * path branch above reports, so it reports the same kind (`io`); the
 * missing-filename check stays outside, where it keeps its own `invalid-arg`.
 */
async function normalizeBlob(source, opts) {
    let data;
    let blobName;
    try {
        data = new Uint8Array(await source.arrayBuffer());
        const named = source.name;
        blobName = typeof named === "string" ? named : undefined;
    }
    catch (e) {
        throw new ChunkError(e instanceof Error ? e.message : String(e), "io");
    }
    return { data, filename: requireFilename(opts.filename ?? blobName) };
}
function requireFilename(name) {
    if (!name) {
        throw new ChunkError("A filename is required for byte sources (pass opts.filename or a named Blob) so the engine can route by extension.", "invalid-arg");
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
// ---------------------------------------------------------------------------
// Option snapshotting + validation
// ---------------------------------------------------------------------------
/** Every key an options object is ever read for. */
const OPT_KEYS = [
    "mode",
    "windowSize",
    "overlap",
    "sentencesPerChunk",
    "paragraphsPerPage",
    "filename",
    "listImages",
];
/**
 * Copy `opts` into a plain object, once, before anything else reads a key.
 *
 * Three escapes from the {@link ChunkError} contract came through this argument
 * and are closed here:
 *  - `getChunks(bytes, null)` threw a raw `TypeError` — the source normaliser
 *    dereferenced `opts.filename` without a guard.
 *  - a throwing *getter* on `opts` propagated as whatever it threw.
 *  - `streamChunks(bytes, opts)` invoked such a getter via `{ ...opts }`, so
 *    even a caller who never read the key paid for it.
 *
 * Every later read goes through the returned plain object, so a getter runs at
 * most once and can never fire mid-parse.
 */
function snapshotOpts(opts) {
    // `undefined` is the documented default; `null` is the same intent, spelled
    // the way a JS (untyped) caller spells it.
    if (opts === undefined || opts === null)
        return {};
    if (typeof opts !== "object" && typeof opts !== "function") {
        throw new ChunkError(`opts must be an object, got ${typeof opts}.`, "invalid-arg");
    }
    const snapshot = {};
    for (const key of OPT_KEYS) {
        let value;
        try {
            value = opts[key];
        }
        catch (e) {
            throw new ChunkError(`opts.${key} could not be read: ${e instanceof Error ? e.message : String(e)}`, "invalid-arg");
        }
        if (value !== undefined)
            snapshot[key] = value;
    }
    return snapshot;
}
/**
 * The numeric options, each paired with the engine's own sentence for
 * "this must be greater than 0" — `null` where the engine has no such rule
 * (`overlap` may legitimately be 0).
 */
const NUMERIC_OPTS = [
    ["windowSize", "window_size must be greater than 0"],
    ["overlap", null],
    ["sentencesPerChunk", "sentences_per_chunk must be greater than 0"],
    ["paragraphsPerPage", "paragraphs_per_page must be greater than 0"],
];
/**
 * Reject option values the wasm boundary cannot carry.
 *
 * The boundary takes `usize`, so a negative, fractional or non-numeric value is
 * coerced rather than rejected: `windowSize: -1` used to return chunks,
 * `2.5` silently truncated to 2, `"3"` silently coerced to 3, and a non-string
 * `filename` / `mode` surfaced as `ChunkError(kind: "unknown")` with the
 * message `memory access out of bounds` — unactionable, and not even the right
 * kind.
 *
 * Out-of-range values reuse the **engine's verbatim** sentence, so the message
 * is identical whichever side rejects. Type mistakes have no engine
 * counterpart, so they name the camelCase key the caller actually typed.
 *
 * Zero is deliberately *not* checked here: the engine already rejects it, per
 * mode, and its message names the parameter the target format actually uses
 * (CSV/spreadsheet modes remap `paragraphsPerPage` onto `rows_per_chunk`).
 * Duplicating the check host-side would replace an accurate message with a
 * misleading one.
 */
function validateOpts(opts) {
    for (const key of ["filename", "mode"]) {
        const value = opts[key];
        if (value !== undefined && typeof value !== "string") {
            throw new ChunkError(`${key} must be a string, got ${typeof value}.`, "invalid-arg");
        }
    }
    for (const [key, tooSmall] of NUMERIC_OPTS) {
        const value = opts[key];
        if (value === undefined)
            continue;
        if (typeof value !== "number" || Number.isNaN(value)) {
            throw new ChunkError(`${key} must be a number, got ${typeof value}.`, "invalid-arg");
        }
        if (!Number.isInteger(value)) {
            throw new ChunkError(`${key} must be an integer, got ${value}.`, "invalid-arg");
        }
        if (value < 0) {
            throw new ChunkError(tooSmall ?? `${key} must not be negative, got ${value}.`, "invalid-arg");
        }
    }
}
/** Snapshot + validate in one step — every public entry point starts here. */
function prepareOpts(opts) {
    const snapshot = snapshotOpts(opts);
    validateOpts(snapshot);
    return snapshot;
}
export async function getChunks(source, opts = {}) {
    const safe = prepareOpts(opts);
    const { data, filename } = await normalizeSource(source, safe);
    const o = resolveOpts(safe);
    const wasm = await loadWasm();
    if (safe.listImages) {
        const raw = wrapWasm(() => wasm.getChunksWithImages(data, filename, o.mode, o.windowSize, o.overlap, o.sentencesPerChunk, o.paragraphsPerPage));
        return { chunks: (raw.chunks ?? []).map(mapChunk), images: (raw.images ?? []).map(mapImage) };
    }
    const raw = wrapWasm(() => wasm.getChunks(data, filename, o.mode, o.windowSize, o.overlap, o.sentencesPerChunk, o.paragraphsPerPage));
    return (raw ?? []).map(mapChunk);
}
export async function getMarkdown(source, opts = {}) {
    const safe = prepareOpts(opts);
    const { data, filename } = await normalizeSource(source, safe);
    const wasm = await loadWasm();
    if (safe.listImages) {
        const raw = wrapWasm(() => wasm.getMarkdownWithImages(data, filename));
        return { markdown: raw.markdown, images: (raw.images ?? []).map(mapImage) };
    }
    return wrapWasm(() => wasm.getMarkdown(data, filename));
}
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
export async function* streamChunks(source, opts = {}) {
    // Snapshot first: spreading a raw `opts` invokes every getter on it, so a
    // throwing getter escaped here even though this function reads no key itself.
    const chunks = await getChunks(source, { ...prepareOpts(opts), listImages: false });
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
    const o = resolveOpts(prepareOpts(opts));
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
    const o = resolveOpts(prepareOpts(opts));
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