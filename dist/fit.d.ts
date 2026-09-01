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
import type { Chunk } from "./index.js";
/** Counts tokens in a string. Any tokenizer: tiktoken, HuggingFace, custom. */
export type TokenCounter = (text: string) => number;
/** Where to break a chunk that exceeds the budget. */
export type FitSplit = "sentence" | "paragraph" | "hard";
/** Whether undersized chunks are joined into the one after them. */
export type FitMerge = "forward" | "none";
/** How two merged chunks' metadata is combined. */
export type FitMergeMetadata = "first" | "union";
/** What to do with a piece that still exceeds the budget after splitting. */
export type FitOversize = "split" | "keep" | "error";
/** Options for {@link fitTokens}. Every default preserves engine output. */
export interface FitOptions {
    /** Merge chunks below this many tokens into the next one. `0` disables. */
    minTokens?: number;
    /** `"forward"` joins an undersized chunk into the one after it. */
    merge?: FitMerge;
    /** Where to break a chunk that exceeds the budget. */
    split?: FitSplit;
    /** `"first"` keeps the leading chunk's values; `"union"` collects both. */
    mergeMetadata?: FitMergeMetadata;
    /** What to do when a single indivisible piece still exceeds the budget. */
    oversize?: FitOversize;
    /** Never merge across a change in {@link FitOptions.boundaryKeys}. */
    respectBoundaries?: boolean;
    /** Metadata keys treated as structural boundaries. */
    boundaryKeys?: readonly string[];
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
export declare function fitTokens(chunks: Iterable<Chunk>, counter: TokenCounter, budget: number, opts?: FitOptions): Chunk[];
//# sourceMappingURL=fit.d.ts.map