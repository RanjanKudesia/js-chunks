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

// Streaming
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
function chunkPdfMarkdown(markdown, totalPages, opts?): Promise<Chunk[]>;
```

`source` may be a **string path** (Node/Bun only), `Uint8Array`, `ArrayBuffer`,
Node `Buffer`, or `Blob`.

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

Works on **Node**, **Bun**, **Deno**, and **browsers/bundlers**. Node and Bun use
the synchronous `pkg-node` build; browsers, Deno and bundlers load the
async-instantiated `pkg-web` build (a `pkg-bundler` build ships for
webpack/rollup/vite `import`). WASM instantiation is lazy and cached on first
call. Filesystem paths are Node/Bun only — elsewhere pass bytes with a
`filename`.

In serverless/edge contexts, run on a **Node.js runtime** so the WASM module and
the optional PDF peer dependency load. See
**[framework integration](https://www.chunkengine.dev/docs/framework-integration/javascript)**
for Express, Fastify, Hono, Next.js, NestJS, and SvelteKit handlers.

## Develop

```bash
npm install
npm run build:wasm   # wasm-pack -> pkg-node / pkg-web / pkg-bundler (needs Rust + wasm-pack)
npm run build        # tsc -> dist/
npm test             # vitest against the real WASM
```

## License

MIT
