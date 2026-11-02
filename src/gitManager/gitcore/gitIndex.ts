// The git index ("staging area"): `.git/index`, versions 2–4 read, version 2/3 written.

import { UnsupportedError } from "./errors";
import { fromHex, toHex } from "./model";
import { sha1_hex } from "./wasm";

export interface IndexEntry {
    path: string;
    oid: string;
    /** e.g. 0o100644 */
    mode: number;
    size: number;
    ctimeSec: number;
    ctimeNsec: number;
    mtimeSec: number;
    mtimeNsec: number;
    dev: number;
    ino: number;
    uid: number;
    gid: number;
    /** 0 for normal entries, 1–3 for the base/ours/theirs sides of a conflict. */
    stage: number;
    assumeValid: boolean;
    skipWorktree: boolean;
    intentToAdd: boolean;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function compareBytes(a: Uint8Array, b: Uint8Array): number {
    const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i++) {
        if (a[i] !== b[i]) return a[i]! - b[i]!;
    }
    return a.length - b.length;
}

export function comparePaths(a: string, b: string): number {
    return compareBytes(encoder.encode(a), encoder.encode(b));
}

/** Stat fields for an index entry from an Obsidian stat (milliseconds). */
export function statFields(stat: {
    mtime: number;
    ctime: number;
    size: number;
}): Pick<
    IndexEntry,
    "ctimeSec" | "ctimeNsec" | "mtimeSec" | "mtimeNsec" | "size"
> {
    const split = (ms: number) => {
        const whole = Math.floor(ms);
        return [Math.floor(whole / 1000), (whole % 1000) * 1e6] as const;
    };
    const [mtimeSec, mtimeNsec] = split(stat.mtime);
    const [ctimeSec, ctimeNsec] = split(stat.ctime);
    return {
        mtimeSec,
        mtimeNsec,
        ctimeSec,
        ctimeNsec,
        size: stat.size % 2 ** 32,
    };
}

/** Whether an entry's cached stat still describes the file (to millisecond precision). */
export function statMatches(
    e: IndexEntry,
    stat: { mtime: number; size: number }
): boolean {
    const entryMs = e.mtimeSec * 1000 + Math.floor(e.mtimeNsec / 1e6);
    return entryMs === Math.floor(stat.mtime) && e.size === stat.size % 2 ** 32;
}

export class GitIndex {
    /** Stage-0 entries by path. */
    readonly entries = new Map<string, IndexEntry>();
    /** Conflicted paths: their stage 1–3 entries. */
    readonly conflicts = new Map<string, IndexEntry[]>();

    static parse(data: Uint8Array): GitIndex {
        const index = new GitIndex();
        if (data.length === 0) return index;
        const view = new DataView(
            data.buffer,
            data.byteOffset,
            data.byteLength
        );
        if (decoder.decode(data.subarray(0, 4)) !== "DIRC") {
            throw new Error("Not a git index file");
        }
        const sum = sha1_hex(data.subarray(0, data.length - 20));
        if (sum !== toHex(data.subarray(data.length - 20))) {
            throw new Error("Git index checksum mismatch");
        }
        const version = view.getUint32(4);
        if (version < 2 || version > 4) {
            throw new UnsupportedError(`Unsupported index version ${version}`);
        }
        const count = view.getUint32(8);
        let off = 12;
        let prevPath: Uint8Array = new Uint8Array(0);
        for (let i = 0; i < count; i++) {
            const start = off;
            const u32 = (o: number) => view.getUint32(start + o);
            const flags = view.getUint16(start + 60);
            off = start + 62;
            let extended = 0;
            if (flags & 0x4000) {
                if (version < 3)
                    throw new Error("Extended flags in a v2 index");
                extended = view.getUint16(off);
                off += 2;
            }
            let pathBytes: Uint8Array;
            if (version === 4) {
                // Varint of bytes to strip from the previous path, then a NUL-terminated suffix.
                let strip = data[off]! & 0x7f;
                while (data[off++]! & 0x80) {
                    strip = ((strip + 1) << 7) | (data[off]! & 0x7f);
                }
                const nul = data.indexOf(0, off);
                const suffix = data.subarray(off, nul);
                pathBytes = new Uint8Array(
                    prevPath.length - strip + suffix.length
                );
                pathBytes.set(prevPath.subarray(0, prevPath.length - strip));
                pathBytes.set(suffix, prevPath.length - strip);
                off = nul + 1;
            } else {
                const nul = data.indexOf(0, off);
                pathBytes = data.subarray(off, nul);
                // Entries are NUL-padded to a multiple of 8 bytes.
                off =
                    start +
                    Math.ceil((off - start + pathBytes.length + 1) / 8) * 8;
            }
            prevPath = pathBytes;
            const entry: IndexEntry = {
                ctimeSec: u32(0),
                ctimeNsec: u32(4),
                mtimeSec: u32(8),
                mtimeNsec: u32(12),
                dev: u32(16),
                ino: u32(20),
                mode: u32(24),
                uid: u32(28),
                gid: u32(32),
                size: u32(36),
                oid: toHex(data.subarray(start + 40, start + 60)),
                assumeValid: (flags & 0x8000) !== 0,
                stage: (flags >> 12) & 3,
                skipWorktree: (extended & 0x4000) !== 0,
                intentToAdd: (extended & 0x2000) !== 0,
                path: decoder.decode(pathBytes),
            };
            if (entry.stage === 0) {
                index.entries.set(entry.path, entry);
            } else {
                const list = index.conflicts.get(entry.path) ?? [];
                list.push(entry);
                index.conflicts.set(entry.path, list);
            }
        }
        // Extensions follow; a split index keeps entries elsewhere.
        while (off + 8 <= data.length - 20) {
            const sig = decoder.decode(data.subarray(off, off + 4));
            if (sig === "link") {
                throw new UnsupportedError(
                    "Split git indexes are not supported"
                );
            }
            off += 8 + view.getUint32(off + 4);
        }
        return index;
    }

    /** All entries in index order (path, then stage). */
    sorted(): IndexEntry[] {
        const all = [...this.entries.values()];
        for (const list of this.conflicts.values()) all.push(...list);
        return all
            .map((e) => ({ e, key: encoder.encode(e.path) }))
            .sort((a, b) => compareBytes(a.key, b.key) || a.e.stage - b.e.stage)
            .map(({ e }) => e);
    }

    /** Serialize as version 2 (or 3 when extended flags are needed); extensions are dropped. */
    serialize(): Uint8Array {
        const entries = this.sorted();
        const version = entries.some((e) => e.skipWorktree || e.intentToAdd)
            ? 3
            : 2;
        const parts: Uint8Array[] = [];
        const header = new Uint8Array(12);
        const hv = new DataView(header.buffer);
        header.set(encoder.encode("DIRC"));
        hv.setUint32(4, version);
        hv.setUint32(8, entries.length);
        parts.push(header);
        for (const e of entries) {
            const path = encoder.encode(e.path);
            const extended = version === 3 && (e.skipWorktree || e.intentToAdd);
            const fixed = 62 + (extended ? 2 : 0);
            const len = Math.ceil((fixed + path.length + 1) / 8) * 8;
            const buf = new Uint8Array(len);
            const v = new DataView(buf.buffer);
            [
                e.ctimeSec,
                e.ctimeNsec,
                e.mtimeSec,
                e.mtimeNsec,
                e.dev,
                e.ino,
                e.mode,
                e.uid,
                e.gid,
                e.size,
            ].forEach((x, i) => v.setUint32(i * 4, x >>> 0));
            buf.set(fromHex(e.oid), 40);
            const flags =
                (e.assumeValid ? 0x8000 : 0) |
                (extended ? 0x4000 : 0) |
                ((e.stage & 3) << 12) |
                Math.min(path.length, 0xfff);
            v.setUint16(60, flags);
            if (extended) {
                v.setUint16(
                    62,
                    (e.skipWorktree ? 0x4000 : 0) | (e.intentToAdd ? 0x2000 : 0)
                );
            }
            buf.set(path, fixed);
            parts.push(buf);
        }
        const size = parts.reduce((n, p) => n + p.length, 0);
        const out = new Uint8Array(size + 20);
        let off = 0;
        for (const p of parts) {
            out.set(p, off);
            off += p.length;
        }
        out.set(fromHex(sha1_hex(out.subarray(0, size))), size);
        return out;
    }
}
