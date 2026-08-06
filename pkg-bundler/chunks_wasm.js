/* @ts-self-types="./chunks_wasm.d.ts" */
import * as wasm from "./chunks_wasm_bg.wasm";
import { __wbg_set_wasm } from "./chunks_wasm_bg.js";

__wbg_set_wasm(wasm);
wasm.__wbindgen_start();
export {
    __start, chunkPdfMarkdown, chunkPdfMarkdownWithImages, getChunks, getChunksWithImages, getMarkdown, getMarkdownWithImages, normalizePdfMarkdown
} from "./chunks_wasm_bg.js";
