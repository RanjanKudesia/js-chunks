# js-chunks

Idiomatic TypeScript/JavaScript wrapper around the WASM-backed
[`rs-chunks`](../rs-chunks) document chunking engine. Output matches the
**py-chunks / rs-chunks** reference engine exactly — this package is a thin,
ergonomic layer over the same WASM core.

## Install

```bash
npm install js-chunks
```

## Usage (Node)

### From a filesystem path

```ts
import { getChunks, getMarkdown } from "js-chunks";

const chunks = await getChunks("./report.docx");
for (const c of chunks) {
  console.log(c.contentType, c.metadata, c.content);
}

const markdown = await getMarkdown("./report.docx");
```

### From bytes (Uint8Array / ArrayBuffer / Buffer / Blob)

When you pass bytes, a `filename` is required so the engine can route by
extension (a named `Blob` supplies its own name):

```ts
import fs from "node:fs";
import { getChunks } from "js-chunks";

const bytes = new Uint8Array(fs.readFileSync("report.docx"));
const chunks = await getChunks(bytes, { filename: "report.docx" });
```

### Streaming

```ts
import { streamChunks } from "js-chunks";

for await (const chunk of streamChunks("./big.md", { mode: "section" })) {
  // same chunks as getChunks(), one at a time
  handle(chunk);
}
```

## Images (`listImages`)

Pass `listImages: true` to also get the document's embedded images back. The
result shape changes to `{ chunks, images }` (or `{ markdown, images }`), where
each image is `{ name: string, data: Uint8Array }` — the `name` matches the
`![](…)` reference used in the markdown and the image chunks:

```ts
const { chunks, images } = await getChunks("./deck.pptx", { listImages: true });
const { markdown, images: mdImages } = await getMarkdown("./deck.pptx", { listImages: true });
```

Formats without embedded images return an empty `images` array.

## PDF

PDF is parsed to Markdown host-side by the optional peer dependency
[`@llamaindex/liteparse-wasm`](https://www.npmjs.com/package/@llamaindex/liteparse-wasm)
(same liteparse version as the Rust engine, so output is byte-identical), then
chunked by the engine. Install it to enable `.pdf` sources:

```bash
npm install @llamaindex/liteparse-wasm
```

```ts
const chunks = await getChunks("./paper.pdf");                    // text
const { chunks: c, images } = await getChunks("./paper.pdf", { listImages: true });
```

If you already have PDF markdown from another parser, chunk it directly without
the peer dependency via `chunkPdfMarkdown(markdown, totalPages, opts?)`.

## API

```ts
interface Chunk {
  content: string;
  contentType: string;              // camelCase (WASM emits content_type)
  metadata: Record<string, unknown>; // passed through untouched
}

interface ChunkImage {
  name: string;                     // matches the ![](name) markdown reference
  data: Uint8Array;                 // raw image bytes
}

type ChunkMode =
  | "default" | "section" | "semantic" | "sentence"
  | "page_aware" | "sliding_window"
  | "row" | "table" | "sheet"        // spreadsheet modes
  | "structural";

interface ChunkOptions {
  mode?: ChunkMode;              // default "default"
  windowSize?: number;          // default 3
  overlap?: number;             // default 1
  sentencesPerChunk?: number;   // default 3
  paragraphsPerPage?: number;   // default 15
  filename?: string;            // required for byte sources
  listImages?: boolean;         // also return embedded images
}

// Overloaded on `listImages`:
function getChunks(source, opts?): Promise<Chunk[]>;
function getChunks(source, opts: { listImages: true }): Promise<{ chunks: Chunk[]; images: ChunkImage[] }>;
function getMarkdown(source, opts?): Promise<string>;
function getMarkdown(source, opts: { listImages: true }): Promise<{ markdown: string; images: ChunkImage[] }>;
function streamChunks(source, opts?): AsyncIterable<Chunk>;
function chunkPdfMarkdown(markdown, totalPages, opts?): Promise<Chunk[]>;
```

`source` may be a **string path** (Node only), a **`Uint8Array`**,
**`ArrayBuffer`**, Node **`Buffer`**, or a **`Blob`**.

`mode` values: `default`, `section`, `semantic`, `sentence`, `page_aware`,
`sliding_window` for prose formats; spreadsheets additionally use `row`,
`table`, `sheet`.

## Runtimes

Works on **Node**, **Bun**, **Deno**, and **browsers / bundlers**. Node and Bun
use the synchronous `pkg-node` build; browsers, Deno, and bundlers load the
async-instantiated `pkg-web` build (a `pkg-bundler` build is also shipped for
webpack/rollup-style `import`). WASM instantiation is lazy and cached on first
call. Filesystem-path sources are Node/Bun only — elsewhere pass bytes with a
`filename`.

## Supported formats

- Markdown / text: `md`, `txt`
- HTML: `html`, `htm`
- Word: `docx`, `docm`, `dotx`, `dotm`, and legacy `doc`
- PowerPoint: `pptx`, `potx`, `potm`, `ppsx`, `ppsm`, and legacy `ppt`
- Spreadsheets: `xlsx`, `xls`, `xlsm`, `xlsb`, `xltx`, `xltm`, `ods`
- Delimited: `csv`, `tsv`
- OpenDocument: `odt`, `odp`
- Rich text: `rtf`
- eBooks: `epub`
- Notebooks: `ipynb`
- Structured data: `json`, `jsonl`, `ndjson`
- Email: `eml`, `mbox`, and Outlook `msg`
- PDF: `pdf` (via the optional `@llamaindex/liteparse-wasm` peer dependency)

## Building

```bash
npm install
npm run build:wasm   # wasm-pack -> pkg-node / pkg-web / pkg-bundler (needs Rust + wasm-pack)
npm run build        # tsc -> dist/ (.js + .d.ts)
npm test             # vitest against the real WASM
```

The WASM artifacts are built from `crates/chunks-wasm` for three targets:

```bash
wasm-pack build --target nodejs    # pkg-node   (Node / Bun)
wasm-pack build --target web       # pkg-web    (browser / Deno)
wasm-pack build --target bundler   # pkg-bundler (webpack / rollup / vite)
```
