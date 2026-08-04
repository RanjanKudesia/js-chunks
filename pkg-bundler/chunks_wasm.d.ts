/* tslint:disable */
/* eslint-disable */
export interface RtfHeader {
    character_set: CharacterSet;
    font_table: FontTable;
    color_table: ColorTable;
    stylesheet: StyleSheet;
}

export type Alignment = "LeftAligned" | "RightAligned" | "Center" | "Justify";

export type CharacterSet = "Ansi" | "Mac" | "Pc" | "Pca" | { Ansicpg: number };

export type FontFamily = "Nil" | "Roman" | "Swiss" | "Modern" | "Script" | "Decor" | "Tech" | "Bidi";

export type SpaceBetweenLine = { Value: number } | "Auto" | "Invalid";


export class Color {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    blue: number;
    green: number;
    red: number;
}

export class Font {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    character_set: number;
    font_family: FontFamily;
    name: string;
}

export class Indentation {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    first_line: number;
    left: number;
    right: number;
}

export class Painter {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    bold: boolean;
    color_ref: number;
    font_ref: number;
    font_size: number;
    italic: boolean;
    smallcaps: boolean;
    strike: boolean;
    subscript: boolean;
    superscript: boolean;
    underline: boolean;
}

export class Paragraph {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    alignment: Alignment;
    indent: Indentation;
    spacing: Spacing;
    tab_width: number;
}

export class RtfDocument {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    body: StyleBlock[];
    header: RtfHeader;
}

/**
 * The vertical margin before / after a block of text
 */
export class Spacing {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    after: number;
    before: number;
    between_line: SpaceBetweenLine;
    line_multiplier: number;
}

export class StyleBlock {
    private constructor();
    free(): void;
    [Symbol.dispose](): void;
    painter: Painter;
    paragraph: Paragraph;
    text: string;
}

/**
 * Install a panic hook that surfaces Rust panics as console errors (dev aid).
 */
export function __start(): void;

/**
 * Chunk PDF markdown produced host-side (e.g. by `@llamaindex/liteparse-wasm`).
 * `total_pages` populates `document_metadata.total_pages`.
 */
export function chunkPdfMarkdown(markdown: string, total_pages: number, mode: string, window_size: number, overlap: number, sentences_per_chunk: number, paragraphs_per_page: number): any;

/**
 * Like [`chunk_pdf_markdown`] but with host-supplied PDF images (image chunks
 * first). `images` is a JS `{ name, data: Uint8Array }[]`. Returns
 * `{ chunks, images }` like [`get_chunks_with_images`].
 */
export function chunkPdfMarkdownWithImages(markdown: string, images: any, total_pages: number, mode: string, window_size: number, overlap: number, sentences_per_chunk: number, paragraphs_per_page: number): any;

/**
 * Chunk a document from raw bytes. `filename` is used only for extension routing.
 * Returns an array of `{ content, content_type, metadata }`.
 */
export function getChunks(data: Uint8Array, filename: string, mode: string, window_size: number, overlap: number, sentences_per_chunk: number, paragraphs_per_page: number): any;

/**
 * Chunk a document and also return its embedded images (py-chunks `list_images=True`).
 * Returns `{ chunks: Chunk[], images: { name, data: Uint8Array }[] }`.
 */
export function getChunksWithImages(data: Uint8Array, filename: string, mode: string, window_size: number, overlap: number, sentences_per_chunk: number, paragraphs_per_page: number): any;

/**
 * Convert a document from raw bytes to Markdown.
 */
export function getMarkdown(data: Uint8Array, filename: string): string;

/**
 * Convert a document to Markdown and also return its embedded images.
 * Returns `{ markdown: string, images: { name, data: Uint8Array }[] }`.
 */
export function getMarkdownWithImages(data: Uint8Array, filename: string): any;

/**
 * Apply the engine's PDF-markdown normalisation to host-parsed markdown.
 *
 * `chunkPdfMarkdown` already does this internally, so chunks agree across SDKs
 * without any help. `getMarkdown` returns the host parser's string directly,
 * which would otherwise skip it — this is what keeps the two in step.
 */
export function normalizePdfMarkdown(markdown: string): string;

export function parse_rtf(rtf: string): RtfDocument;
