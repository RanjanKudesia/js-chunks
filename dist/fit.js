/**
 * Fit chunks to a token budget — the JS half of what `py-chunks` exposes as
 * `fit_tokens`.
 *
 * Why this is host-side and not in the engine
 * -------------------------------------------
 * Token counting is tokenizer-specific: tiktoken in Python, `gpt-tokenizer` or
 * a `@xenova/transformers` tokenizer or a plain word count here. Putting a
 * token budget in `rs-chunks` would mean either vendoring one tokenizer (wrong
 * for anyone on a different embedding model) or calling back into the host
 * language, which breaks the byte-identical parity guarantee the product rests
 * on. Characters are parity-safe; tokens are not.
 *
 * So the engine keeps producing byte-identical, structure-aware chunks and this
 * module re-fits them to *your* tokenizer. It is **deliberately parity-exempt**:
 * output depends on the counter you pass, so it is not part of the cross-SDK
 * byte-identical contract.
 *
 * It is a pure function over `Chunk[]` — no wasm, no I/O, no `await` — so it is
 * the one export here that is synchronous and runs identically in Node, Bun,
 * Deno and the browser.
 *
 * @example
 * ```ts
 * import { getChunks, fitTokens } from "js-chunks";
 * import { encode } from "gpt-tokenizer";
 *
 * const chunks = await getChunks("report.pdf");
 * const fitted = fitTokens(chunks, (s) => encode(s).length, 512);
 * ```
 */
import { ChunkError } from "./errors.js";
const DEFAULT_BOUNDARY_KEYS = ["section_heading", "page_number", "sheet_name"];
const SENTENCE_END = /(?<=[.!?])\s+/;
const PARAGRAPH = /\n\s*\n/;
const SPLITS = new Set(["sentence", "paragraph", "hard"]);
const MERGES = new Set(["forward", "none"]);
const MERGE_METADATAS = new Set(["first", "union"]);
const OVERSIZES = new Set(["split", "keep", "error"]);
/**
 * Reject an unrecognised enum value instead of silently falling through.
 *
 * A typo like `split: "sentances"` would otherwise quietly select the hard
 * whitespace split — a different chunking strategy, applied without complaint.
 * py-chunks validates the same four options the same way.
 */
function checkEnum(name, value, allowed) {
    if (!allowed.has(value)) {
        const options = [...allowed].map((v) => `"${v}"`).join(", ");
        throw new ChunkError(`${name} must be one of ${options}, got "${value}".`, "invalid-arg");
    }
}
/** Break `text` into candidate pieces, largest-grain first. */
function splitText(text, how) {
    let parts;
    if (how === "paragraph") {
        parts = text.split(PARAGRAPH).filter((p) => p.trim() !== "");
    }
    else if (how === "sentence") {
        parts = text.split(SENTENCE_END).filter((p) => p.trim() !== "");
    }
    else {
        // "hard" — last resort, split on whitespace. Mirrors Python's bare
        // `str.split()`, which drops the empty leading field a `/\s+/` split
        // produces for leading whitespace.
        parts = text.split(/\s+/).filter((p) => p !== "");
    }
    return parts.length > 0 ? parts : [text];
}
/** Greedily pack `pieces` into runs that fit `budget`. */
function pack(pieces, counter, budget, joiner) {
    const out = [];
    let cur = [];
    for (const piece of pieces) {
        const candidate = cur.length > 0 ? [...cur, piece].join(joiner) : piece;
        if (cur.length > 0 && counter(candidate) > budget) {
            out.push(cur.join(joiner));
            cur = [piece];
        }
        else {
            cur.push(piece);
        }
    }
    if (cur.length > 0)
        out.push(cur.join(joiner));
    return out;
}
/**
 * Combine two chunks' metadata.
 *
 * `"first"` keeps the leading chunk's values and never invents one. `"union"`
 * collects differing scalars into an array, so a chunk spanning two pages
 * reports both rather than silently claiming one — which would be a fabricated
 * value.
 */
function mergeMeta(a, b, how) {
    if (how === "first")
        return { ...a };
    const merged = { ...a };
    for (const [k, v] of Object.entries(b)) {
        if (!(k in merged)) {
            merged[k] = v;
        }
        else if (!sameValue(merged[k], v)) {
            const cur = Array.isArray(merged[k]) ? merged[k] : [merged[k]];
            merged[k] = [...cur, ...(Array.isArray(v) ? v : [v])];
        }
    }
    return merged;
}
/**
 * Value equality for metadata, matching Python's `!=` rather than JS `===`.
 *
 * Metadata is JSON, so two structurally equal arrays or objects must compare
 * equal — reference equality would append a duplicate of a list-valued key on
 * every merge.
 */
function sameValue(a, b) {
    if (Object.is(a, b))
        return true;
    if (a === null || b === null || typeof a !== "object" || typeof b !== "object")
        return false;
    return JSON.stringify(a) === JSON.stringify(b);
}
/**
 * The boundary signature of one chunk: its `boundaryKeys` values, stringified.
 *
 * Scalars go through `String` so `1` and `"1"` compare equal, as they do in
 * py-chunks. Objects and arrays are JSON-encoded instead, because `String` would
 * flatten every one of them to `"[object Object]"` and merge across boundaries
 * that genuinely differ.
 */
function boundaryOf(c, boundaryKeys) {
    const meta = c.metadata ?? {};
    return boundaryKeys
        .map((k) => {
        const v = meta[k];
        return v === null || typeof v !== "object" ? String(v) : JSON.stringify(v);
    })
        .join(" ");
}
/**
 * Re-fit engine chunks to a token budget.
 *
 * `getChunks` produces structure-aware chunks sized in characters, because
 * characters are the only unit that can be byte-identical across SDKs. This
 * re-fits that output to a token budget using the counter you supply, so you
 * get the "no chunk exceeds N tokens" guarantee on all 36 formats *and* keep
 * `contentType` and `metadata` — including the repeated table headers that make
 * a retrieved row interpretable.
 *
 * Every option defaults to preserving what the engine gave you, so calling it
 * with just a counter and a budget only ever *splits* what is over budget.
 *
 * Split parts carry `fit_part` (1-based) and `fit_total` in their metadata.
 * Inputs are never mutated; a new array of new objects is returned.
 *
 * @param chunks Output of {@link getChunks}, or any `Chunk[]`.
 * @param counter Your tokenizer, as `(text) => number`.
 * @param budget Maximum tokens per returned chunk. Must be at least 1.
 * @throws {ChunkError} `kind: "invalid-arg"` for a bad budget, a negative
 *   `minTokens`, an unrecognised option value, or an oversize chunk when
 *   `oversize: "error"`.
 */
export function fitTokens(chunks, counter, budget, opts = {}) {
    const minTokens = opts.minTokens ?? 0;
    const merge = opts.merge ?? "forward";
    const split = opts.split ?? "sentence";
    const metaPolicy = opts.mergeMetadata ?? "first";
    const oversize = opts.oversize ?? "split";
    const respectBoundaries = opts.respectBoundaries ?? true;
    const boundaryKeys = opts.boundaryKeys ?? DEFAULT_BOUNDARY_KEYS;
    if (typeof budget !== "number" || !Number.isInteger(budget)) {
        throw new ChunkError(`budget must be an integer, got ${String(budget)}.`, "invalid-arg");
    }
    if (budget < 1) {
        throw new ChunkError("budget must be greater than 0", "invalid-arg");
    }
    if (typeof minTokens !== "number" || !Number.isInteger(minTokens)) {
        throw new ChunkError(`minTokens must be an integer, got ${String(minTokens)}.`, "invalid-arg");
    }
    if (minTokens < 0) {
        throw new ChunkError("minTokens must not be negative", "invalid-arg");
    }
    if (typeof counter !== "function") {
        throw new ChunkError(`counter must be a function, got ${typeof counter}.`, "invalid-arg");
    }
    checkEnum("merge", merge, MERGES);
    checkEnum("split", split, SPLITS);
    checkEnum("mergeMetadata", metaPolicy, MERGE_METADATAS);
    checkEnum("oversize", oversize, OVERSIZES);
    const items = [...chunks].map((c) => ({ ...c }));
    if (items.length === 0)
        return [];
    // ---- pass 1: merge undersized chunks forward ----------------------------
    const merged = merge === "forward" && minTokens > 0
        ? mergeForward(items, counter, budget, {
            minTokens,
            metaPolicy,
            respectBoundaries,
            boundaryKeys,
        })
        : items;
    // ---- pass 2: split whatever is over budget ------------------------------
    const out = [];
    for (const c of merged) {
        out.push(...refitOne(c, counter, budget, split, oversize));
    }
    return out;
}
/** Pass 1 — join each undersized chunk into the one that follows it. */
function mergeForward(items, counter, budget, cfg) {
    const merged = [];
    let pending = null;
    for (const c of items) {
        if (pending === null) {
            pending = c;
            continue;
        }
        const same = !cfg.respectBoundaries ||
            boundaryOf(pending, cfg.boundaryKeys) === boundaryOf(c, cfg.boundaryKeys);
        const joined = `${pending.content}\n\n${c.content}`;
        if (counter(pending.content) < cfg.minTokens && same && counter(joined) <= budget) {
            pending = {
                ...pending,
                content: joined,
                metadata: mergeMeta(pending.metadata ?? {}, c.metadata ?? {}, cfg.metaPolicy),
            };
        }
        else {
            merged.push(pending);
            pending = c;
        }
    }
    if (pending !== null)
        merged.push(pending);
    return merged;
}
/** Pass 2 — `c` unchanged when it already fits, otherwise its split parts. */
function refitOne(c, counter, budget, split, oversize) {
    const text = c.content ?? "";
    if (counter(text) <= budget || oversize === "keep")
        return [c];
    if (oversize === "error") {
        throw new ChunkError(`chunk of ${counter(text)} tokens exceeds budget ${budget} and ` +
            `oversize='error' (contentType=${JSON.stringify(c.contentType)})`, "invalid-arg");
    }
    const pieces = pack(splitText(text, split), counter, budget, " ");
    // A single piece can still exceed the budget (one very long sentence, or a
    // table row that must not be cut mid-record). Fall back to a coarser split for
    // those rather than emitting something over budget.
    const final = [];
    for (const piece of pieces) {
        if (counter(piece) <= budget) {
            final.push(piece);
        }
        else {
            final.push(...pack(splitText(piece, "hard"), counter, budget, " "));
        }
    }
    return final.map((piece, i) => ({
        ...c,
        content: piece,
        metadata: { ...c.metadata, fit_part: i + 1, fit_total: final.length },
    }));
}
//# sourceMappingURL=fit.js.map