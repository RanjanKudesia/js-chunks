# js-chunks

> **Part of [chunk-engine](https://github.com/RanjanKudesia/chunk-engine)** — one Rust engine, three byte-identical SDKs ([py-chunks](https://pypi.org/project/py-chunks/) · [js-chunks](https://www.npmjs.com/package/js-chunks) · [rs-chunks](https://crates.io/crates/rs-chunks)).
> Full documentation, playground and benchmarks: **[chunkengine.dev](https://www.chunkengine.dev)**

[![npm](https://img.shields.io/npm/v/js-chunks?style=flat-square&color=e8511e)](https://www.npmjs.com/package/js-chunks)
[![License](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)

The **JavaScript / TypeScript** binding for chunk-engine. Turn any of **36
document formats** into typed, structure-aware chunks for RAG — the engine is
compiled to **WASM**, so it runs in Node, Bun, Deno, and the browser.

## Install

```bash
npm install js-chunks
```

## Quick start

```ts
import { getChunks, streamChunks, getMarkdown } from "js-chunks";

// From a path (Node / Bun only)
const chunks = await getChunks("./report.pdf", { mode: "semantic" });

for (const c of chunks) {
  console.log(c.contentType, c.metadata, c.content);
}

// From bytes — a filename is required so the engine can route by extension
const bytes = new Uint8Array(await file.arrayBuffer());
await getChunks(bytes, { filename: "report.docx" });

// Iterate chunk by chunk (ergonomic wrapper — see "Streaming" below)
for await (const chunk of streamChunks("./big.md", { mode: "section" })) {
  handle(chunk);
}

// Markdown conversion
const md = await getMarkdown("./report.docx");
```

In the browser, pass a `File`/`Blob` straight from an `<input type="file">` — a
named `Blob` supplies its own filename.

📖 **[Chunking modes](https://www.chunkengine.dev/docs/chunking-modes)** ·
**[Supported formats](https://www.chunkengine.dev/docs/supported-formats)** ·
**[Output schema](https://www.chunkengine.dev/docs/output-schema)** ·
**[Metadata reference](https://www.chunkengine.dev/docs/metadata-reference)**

## API

```ts
interface Chunk {
  content: string;
  contentType: string;               // camelCase (the WASM core emits content_type)
  metadata: Record<string, unknown>; // passed through untouched
}

interface ChunkImage {
  name: string;                      // matches the ![](name) markdown reference
  data: Uint8Array;
}

interface ChunkOptions {
  mode?: ChunkMode;             // default "default"
  windowSize?: number;          // default 3   — sliding_window
  overlap?: number;             // default 1   — sliding_window
  sentencesPerChunk?: number;   // default 3   — sentence
  paragraphsPerPage?: number;   // default 15  — page_aware
  filename?: string;            // required for byte sources
  listImages?: boolean;
}

// Overloaded on `listImages`:
function getChunks(source, opts?): Promise<Chunk[]>;
function getChunks(source, opts: { listImages: true }): Promise<{ chunks: Chunk[]; images: ChunkImage[] }>;
function getMarkdown(source, opts?): Promise<string>;
function getMarkdown(source, opts: { listImages: true }): Promise<{ markdown: string; images: ChunkImage[] }>;
function streamChunks(source, opts?): AsyncIterable<Chunk>;
// For markdown some *other* PDF parser produced (.pdf input needs none of these):
function chunkPdfMarkdown(markdown, totalPages, opts?): Promise<Chunk[]>;
function chunkPdfMarkdownWithImages(markdown, images, totalPages, opts?): Promise<{ chunks: Chunk[]; images: ChunkImage[] }>;
function normalizePdfMarkdown(markdown): Promise<string>;
```

`source` may be a **string path** (Node/Bun only), `Uint8Array`, `ArrayBuffer`,
Node `Buffer`, or `Blob`.

## Errors

**Every** failure this package raises is a `ChunkError` (a real `Error`
subclass) — engine failures and host-side argument validation alike, so a
single `instanceof ChunkError` catch is the complete contract. For engine
failures the `message` is **byte-identical** to the message `py-chunks` raises
for the same input — the cross-SDK parity contract — and the variant py-chunks
expresses as an exception *type* is restored on `kind`:

```ts
import { getChunks, ChunkError, type ChunkErrorKind } from "js-chunks";

try {
  await getChunks(bytes, { filename: "data.xyz" });
} catch (e) {
  if (e instanceof ChunkError) {
    e.kind;    // "unsupported" | "invalid-arg" | "parse" | "io" | "unknown"
    e.message; // for engine errors, exactly what py-chunks raises
  }
}
```

Argument validation that never reaches the engine — a filesystem path off
Node, an unsupported `source` type, byte input with no filename — has no
py-chunks counterpart and is reported as `kind: "invalid-arg"`.

## Streaming

`streamChunks` is an **ergonomic wrapper, not incremental streaming.** The
WASM boundary is a synchronous full-parse, so it computes the complete chunk
array and *then* yields the elements one at a time:

```ts
for await (const chunk of streamChunks("./big.docx")) { … }
// identical results — and identical peak memory — to:
for (const chunk of await getChunks("./big.docx")) { … }
```

Use it for `for await` ergonomics and to interleave downstream work (embedding,
upserting) with iteration — not to bound memory on a large file. `rs-chunks`
and `py-chunks` do offer genuinely incremental streaming for some formats;
WASM does not, and closing that gap would be an engine redesign rather than a
wrapper change.

## Images

```ts
const { chunks, images } = await getChunks("./deck.pptx", { listImages: true });
const { markdown, images: mdImages } = await getMarkdown("./deck.pptx", { listImages: true });
```

Formats without embedded images return an empty `images` array.

## PDF

PDF is parsed by the engine itself, in WASM — no peer dependency, and the same
code `py-chunks` and `rs-chunks` run. Over the 24-document PDF corpus, markdown,
chunks and image bytes are identical to `py-chunks` on **23 of 24**.

The exception is rendering: a scanned PDF with no text *and* no embedded page
image is rasterised natively, which WASM cannot do, so it reports that it has no
extractable text instead.

If you already have PDF markdown from another parser, chunk it directly with
`chunkPdfMarkdown(markdown, totalPages, opts?)`.

## Runtimes

Works on **Node**, **Bun**, **Deno**, and **browsers**. Node and Bun use the
synchronous `pkg-node` build; Deno and unbundled browser ESM load the
async-instantiated `pkg-web` build automatically. WASM instantiation is lazy
and cached on first call. Filesystem paths are Node/Bun only — elsewhere pass
bytes with a `filename`.

This package is **ESM-only**. `require("js-chunks")` works on Node ≥ 20.19 and
≥ 22.12 (which can `require()` ESM); on older Node use `import` / dynamic
`import()`.

In serverless/edge contexts, run on a **Node.js runtime** so the WASM module
loads (PDF parsing happens inside the engine — there is no peer dependency).
See
**[framework integration](https://www.chunkengine.dev/docs/framework-integration/javascript)**
for Express, Fastify, Hono, Next.js, NestJS, and SvelteKit handlers.

## Bundlers (vite/webpack)

The main entry's runtime auto-detection loads the web build through a dynamic
import that is deliberately hidden from bundlers (`@vite-ignore`), so it only
works where the import specifier resolves at runtime (Node, Bun, Deno,
unbundled browser ESM). A **bundled** app would neither bundle the glue nor
copy the `.wasm` binary — so bundled apps import the web build explicitly via
the `js-chunks/web` subpath and serve `chunks_wasm_bg.wasm` as an asset:

```ts
import initWasm, * as engine from "js-chunks/web";
// vite: resolve the wasm binary to a served asset URL
import wasmUrl from "js-chunks/web/chunks_wasm_bg.wasm?url";

await initWasm({ module_or_path: wasmUrl }); // once, cached
const chunks = engine.getChunks(bytes, "report.docx", "default", 3, 1, 3, 15);
```

`js-chunks/web` is the raw wasm-bindgen surface: positional arguments, chunks
as `{ content, content_type, metadata }` (snake_case), and an `init` default
export that must be awaited before any call. If your bundler already rewrites
`new URL("chunks_wasm_bg.wasm", import.meta.url)` inside the glue to an asset
URL, plain `await initWasm()` works too — the explicit `?url` form above is
the dependable one.

## Develop

```bash
npm install
npm run build:wasm   # wasm-pack -> pkg-node / pkg-web (needs Rust + wasm-pack)
npm run build        # tsc -> dist/
npm test             # builds dist/, then vitest against the real WASM
```

Tests resolve fixtures from the workspace corpus (`../test_files`) when
present, else from the committed subset in `test/fixtures/` (what CI uses).
Set `JS_CHUNKS_FIXTURES=local` to force the committed subset.

## License

MIT
