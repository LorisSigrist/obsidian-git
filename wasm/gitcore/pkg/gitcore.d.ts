/* tslint:disable */
/* eslint-disable */

/**
 * Indexes a pack as it streams in (`push`), then resolves deltas against the stored
 * pack (`next_read` / `provide`) and produces a v2 `.idx`.
 */
export class PackIndexer {
    free(): void;
    [Symbol.dispose](): void;
    build_idx(): Uint8Array;
    checksum_hex(): string | undefined;
    /**
     * End of stream: verifies the trailer and prepares delta resolution.
     */
    finish(): void;
    constructor();
    /**
     * The next `[offset, length]` of the stored pack needed, or `undefined` when done.
     */
    next_read(): Float64Array | undefined;
    object_count(): number;
    pack_len(): number;
    provide(bytes: Uint8Array | number[]): void;
    push(chunk: Uint8Array | number[]): void;
}

/**
 * Random-access object reads from one pack + `.idx`.
 */
export class PackReader {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Start reading an object. Then, for each `[offset, len]` from `next_read`, feed
     * that range with `provide_part` and close it with `provide_end`, until `next_read`
     * is `undefined`. The object is then available via `kind`, `len` and `read_data`.
     */
    begin(oid_hex: string): void;
    has(oid_hex: string): boolean;
    /**
     * "commit" | "tree" | "blob" | "tag"
     */
    kind(): string;
    len(): number;
    constructor(idx: Uint8Array | number[], pack_len: number, cache_bytes: number);
    next_read(): Float64Array | undefined;
    /**
     * All oids in this pack whose hex form starts with `prefix`.
     */
    oids_with_prefix(prefix: string): string[];
    /**
     * The pack checksum recorded in the `.idx` (to compare with the pack trailer).
     */
    pack_checksum_hex(): string;
    provide_end(): void;
    provide_part(bytes: Uint8Array | number[]): void;
    /**
     * Copy out `len` bytes of the current object starting at `offset`.
     */
    read_data(offset: number, len: number): Uint8Array;
    /**
     * Release the current object.
     */
    release(): void;
}

/**
 * Writes a pack without deltas, entry by entry. Every returned piece is part of the
 * pack stream, in order: `header()`, one `entry()` per object, then `finish()`.
 */
export class PackWriter {
    free(): void;
    [Symbol.dispose](): void;
    entry(kind: string, data: Uint8Array | number[]): Uint8Array;
    finish(): Uint8Array;
    header(): Uint8Array;
    constructor(count: number);
}

export function deflate(data: Uint8Array | number[]): Uint8Array;

/**
 * Git object id of `data` as an object of type `kind`.
 */
export function hash_object(kind: string, data: Uint8Array | number[]): string;

export function inflate(data: Uint8Array | number[]): Uint8Array;

/**
 * Hex SHA-1 of raw bytes.
 */
export function sha1_hex(data: Uint8Array | number[]): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_packindexer_free: (a: number, b: number) => void;
    readonly __wbg_packreader_free: (a: number, b: number) => void;
    readonly __wbg_packwriter_free: (a: number, b: number) => void;
    readonly deflate: (a: number, b: number) => [number, number];
    readonly hash_object: (a: number, b: number, c: number, d: number) => [number, number, number, number];
    readonly inflate: (a: number, b: number) => [number, number, number, number];
    readonly packindexer_build_idx: (a: number) => [number, number, number, number];
    readonly packindexer_checksum_hex: (a: number) => [number, number];
    readonly packindexer_finish: (a: number) => [number, number];
    readonly packindexer_new: () => number;
    readonly packindexer_next_read: (a: number) => [number, number, number, number];
    readonly packindexer_object_count: (a: number) => number;
    readonly packindexer_pack_len: (a: number) => number;
    readonly packindexer_provide: (a: number, b: number, c: number) => [number, number];
    readonly packindexer_push: (a: number, b: number, c: number) => [number, number];
    readonly packreader_begin: (a: number, b: number, c: number) => [number, number];
    readonly packreader_has: (a: number, b: number, c: number) => [number, number, number];
    readonly packreader_kind: (a: number) => [number, number];
    readonly packreader_len: (a: number) => number;
    readonly packreader_new: (a: number, b: number, c: number, d: number) => [number, number, number];
    readonly packreader_next_read: (a: number) => [number, number];
    readonly packreader_oids_with_prefix: (a: number, b: number, c: number) => [number, number];
    readonly packreader_pack_checksum_hex: (a: number) => [number, number];
    readonly packreader_provide_end: (a: number) => [number, number];
    readonly packreader_provide_part: (a: number, b: number, c: number) => [number, number];
    readonly packreader_read_data: (a: number, b: number, c: number) => [number, number];
    readonly packreader_release: (a: number) => void;
    readonly packwriter_entry: (a: number, b: number, c: number, d: number, e: number) => [number, number, number, number];
    readonly packwriter_finish: (a: number) => [number, number, number, number];
    readonly packwriter_header: (a: number) => [number, number];
    readonly packwriter_new: (a: number) => number;
    readonly sha1_hex: (a: number, b: number) => [number, number];
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __externref_drop_slice: (a: number, b: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
