import wasmBytes from "../../../wasm/gitcore/pkg/gitcore_bg.wasm";
import init from "../../../wasm/gitcore/pkg/gitcore";

export {
    PackIndexer,
    PackReader,
    PackWriter,
    deflate,
    hash_object,
    inflate,
    sha1_hex,
} from "../../../wasm/gitcore/pkg/gitcore";

let ready: Promise<unknown> | undefined;

/**
 * Compile the git core. Chromium (desktop, Android) refuses synchronous
 * compilation of modules this size on the main thread, so this is async and
 * must be awaited before any other export is used.
 */
export function loadWasm(): Promise<unknown> {
    ready ??= init({ module_or_path: wasmBytes });
    return ready;
}
