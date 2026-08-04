/* @ts-self-types="./chunks_wasm.d.ts" */
import * as wasm from "./chunks_wasm_bg.wasm";
import { __wbg_set_wasm } from "./chunks_wasm_bg.js";

__wbg_set_wasm(wasm);
wasm.__wbindgen_start();
export {
    Color, Font, Indentation, Painter, Paragraph, RtfDocument, Spacing, StyleBlock, __start, chunkPdfMarkdown, chunkPdfMarkdownWithImages, getChunks, getChunksWithImages, getMarkdown, getMarkdownWithImages, normalizePdfMarkdown, parse_rtf
} from "./chunks_wasm_bg.js";
