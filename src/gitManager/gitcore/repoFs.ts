import type { DataAdapter, Vault } from "obsidian";
import { TFile, TFolder } from "obsidian";

/** Reads `length` bytes at `offset` of a vault file. */
export type RangeReader = (
    path: string,
    offset: number,
    length: number
) => Promise<Uint8Array>;

export interface FileStat {
    type: "file" | "folder";
    size: number;
    mtime: number;
    ctime: number;
}

const BLOCK = 1 << 20;
const CACHED_BLOCKS = 8;

const toArrayBuffer = (u: Uint8Array): ArrayBuffer =>
    u.byteOffset === 0 && u.byteLength === u.buffer.byteLength
        ? (u.buffer as ArrayBuffer)
        : u.slice().buffer;

/**
 * Vault-relative file access for the git implementation.
 *
 * Files inside dot-folders (like `.git`) go through the raw adapter; visible
 * vault files go through the Vault API so Obsidian's caches and open editors
 * see the change, the same split `MyAdapter` made for isomorphic-git.
 *
 * Packfiles need random access, which Obsidian's API does not offer. `readRange`
 * serves reads from 1 MB blocks fetched with a ranged request against the
 * file's resource URL (verified once; a server that ignores `Range` is
 * detected), falling back to reading the whole file once.
 */
export class RepoFs {
    private readonly adapter: DataAdapter;
    private readonly knownDirs = new Set<string>();
    private readonly blocks = new Map<string, Uint8Array>();
    private wholeFile: { path: string; data: Uint8Array } | undefined;
    private rangeSupport: "unknown" | "yes" | "no" = "unknown";

    constructor(
        private readonly vault: Vault,
        private readonly rangeReader?: RangeReader
    ) {
        this.adapter = vault.adapter;
    }

    private isHidden(path: string): boolean {
        return path
            .split("/")
            .some((part) => part.startsWith(".") && part !== ".");
    }

    async exists(path: string): Promise<boolean> {
        return this.adapter.exists(path);
    }

    async stat(path: string): Promise<FileStat | null> {
        const s = await this.adapter.stat(path);
        if (!s) return null;
        return { type: s.type, size: s.size, mtime: s.mtime, ctime: s.ctime };
    }

    async read(path: string): Promise<Uint8Array | null> {
        if (!(await this.adapter.exists(path))) return null;
        return new Uint8Array(await this.adapter.readBinary(path));
    }

    async readText(path: string): Promise<string | null> {
        if (!(await this.adapter.exists(path))) return null;
        return this.adapter.read(path);
    }

    async mkdirp(path: string): Promise<void> {
        if (path === "" || path === "." || path === "/") return;
        if (this.knownDirs.has(path)) return;
        const parent = path.includes("/")
            ? path.slice(0, path.lastIndexOf("/"))
            : "";
        await this.mkdirp(parent);
        if (!(await this.adapter.exists(path))) {
            if (this.isHidden(path)) {
                await this.adapter.mkdir(path);
            } else {
                await this.vault.createFolder(path).catch(async (e) => {
                    // A concurrent writer may have created it in the meantime.
                    if (!(await this.adapter.exists(path))) throw e;
                });
            }
        }
        this.knownDirs.add(path);
    }

    private async ensureParent(path: string): Promise<void> {
        const slash = path.lastIndexOf("/");
        if (slash > 0) await this.mkdirp(path.slice(0, slash));
    }

    async write(path: string, data: Uint8Array | string): Promise<void> {
        this.forget(path);
        await this.ensureParent(path);
        if (!this.isHidden(path)) {
            const file = this.vault.getAbstractFileByPath(path);
            if (file instanceof TFile) {
                if (typeof data === "string")
                    return this.vault.modify(file, data);
                return this.vault.modifyBinary(file, toArrayBuffer(data));
            }
            if (!(await this.adapter.exists(path))) {
                if (typeof data === "string") {
                    await this.vault.create(path, data);
                } else {
                    await this.vault.createBinary(path, toArrayBuffer(data));
                }
                return;
            }
        }
        if (typeof data === "string") return this.adapter.write(path, data);
        return this.adapter.writeBinary(path, toArrayBuffer(data));
    }

    /** Append to a (hidden) file, creating it if needed. */
    async append(path: string, data: Uint8Array): Promise<void> {
        this.forget(path);
        if (!(await this.adapter.exists(path))) {
            await this.ensureParent(path);
            return this.adapter.writeBinary(path, toArrayBuffer(data));
        }
        return this.adapter.appendBinary(path, toArrayBuffer(data));
    }

    async remove(path: string): Promise<void> {
        this.forget(path);
        if (!this.isHidden(path)) {
            const file = this.vault.getAbstractFileByPath(path);
            if (file instanceof TFile) return this.vault.delete(file);
        }
        if (await this.adapter.exists(path)) await this.adapter.remove(path);
    }

    async rmdir(path: string, recursive: boolean): Promise<void> {
        for (const d of [...this.knownDirs]) {
            if (d === path || d.startsWith(path + "/"))
                this.knownDirs.delete(d);
        }
        if (!this.isHidden(path)) {
            const folder = this.vault.getAbstractFileByPath(path);
            if (folder instanceof TFolder)
                return this.vault.delete(folder, recursive);
        }
        if (await this.adapter.exists(path))
            await this.adapter.rmdir(path, recursive);
    }

    async rename(from: string, to: string): Promise<void> {
        this.forget(from);
        this.forget(to);
        await this.ensureParent(to);
        await this.adapter.rename(from, to);
    }

    /** Names (not paths) of the entries in a directory; empty if it is missing. */
    async list(path: string): Promise<{ files: string[]; folders: string[] }> {
        const dir = path === "" ? "/" : path;
        if (!(await this.adapter.exists(dir)))
            return { files: [], folders: [] };
        const res = await this.adapter.list(dir);
        const name = (p: string) => p.slice(p.lastIndexOf("/") + 1);
        return { files: res.files.map(name), folders: res.folders.map(name) };
    }

    private forget(path: string): void {
        for (const key of [...this.blocks.keys()]) {
            if (key.startsWith(path + "#")) this.blocks.delete(key);
        }
        if (this.wholeFile?.path === path) this.wholeFile = undefined;
    }

    private async fetchRange(
        path: string,
        offset: number,
        length: number
    ): Promise<Uint8Array | null> {
        if (this.rangeReader) return this.rangeReader(path, offset, length);
        if (this.rangeSupport === "no") return null;
        if (typeof fetch !== "function" || !("getResourcePath" in this.adapter))
            return null;
        try {
            const res = await fetch(this.adapter.getResourcePath(path), {
                headers: { Range: `bytes=${offset}-${offset + length - 1}` },
            });
            if (res.status === 206) {
                const body = new Uint8Array(await res.arrayBuffer());
                if (body.byteLength === length) {
                    this.rangeSupport = "yes";
                    return body;
                }
            }
            await res.body?.cancel();
        } catch {
            // fall through to the whole-file path
        }
        this.rangeSupport = "no";
        return null;
    }

    private async block(path: string, index: number, size: number) {
        const key = `${path}#${index}`;
        let data = this.blocks.get(key);
        if (data) {
            this.blocks.delete(key);
        } else {
            const offset = index * BLOCK;
            const length = Math.min(BLOCK, size - offset);
            data =
                (await this.fetchRange(path, offset, length)) ??
                (await this.whole(path)).subarray(offset, offset + length);
            if (this.blocks.size >= CACHED_BLOCKS) {
                this.blocks.delete(this.blocks.keys().next().value!);
            }
        }
        this.blocks.set(key, data);
        return data;
    }

    private async whole(path: string): Promise<Uint8Array> {
        if (this.wholeFile?.path !== path) {
            this.wholeFile = undefined;
            this.wholeFile = {
                path,
                data: new Uint8Array(await this.adapter.readBinary(path)),
            };
        }
        return this.wholeFile.data;
    }

    /**
     * Yield `length` bytes at `offset` of `path` (whose size is `size`) as a
     * sequence of views into cached blocks.
     */
    async *readRangeParts(
        path: string,
        size: number,
        offset: number,
        length: number
    ): AsyncGenerator<Uint8Array> {
        let done = 0;
        while (done < length) {
            const pos = offset + done;
            const index = Math.floor(pos / BLOCK);
            const block = await this.block(path, index, size);
            const start = pos - index * BLOCK;
            const n = Math.min(block.byteLength - start, length - done);
            if (n <= 0) throw new Error(`Read past the end of ${path}`);
            yield block.subarray(start, start + n);
            done += n;
        }
    }

    async readRange(
        path: string,
        size: number,
        offset: number,
        length: number
    ): Promise<Uint8Array> {
        const out = new Uint8Array(length);
        let done = 0;
        for await (const part of this.readRangeParts(
            path,
            size,
            offset,
            length
        )) {
            out.set(part, done);
            done += part.byteLength;
        }
        return out;
    }
}
