import { NotFoundError } from "./errors";
import {
    parseCommit,
    parseTag,
    parseTree,
    type Commit,
    type ObjectType,
    type TreeEntry,
} from "./model";
import type { RepoFs } from "./repoFs";
import { deflate, hash_object, inflate, PackReader } from "./wasm";

export interface GitObject {
    type: ObjectType;
    data: Uint8Array;
}

interface Pack {
    name: string;
    path: string;
    size: number;
    reader: PackReader;
    verified: boolean;
    /** Tail of the promise chain that serializes use of the stateful reader. */
    lock: Promise<unknown>;
}

const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** Small objects (trees, commits) are read over and over during walks. */
const CACHE_LIMIT = 16 << 20;
const CACHE_MAX_OBJECT = 256 << 10;

/**
 * Loose objects and packs under `<gitdir>/objects`.
 *
 * Pack objects are reconstructed inside WASM from byte ranges read on demand,
 * so a pack is never loaded whole.
 */
export class ObjectDb {
    private packs: Pack[] | undefined;
    private readonly cache = new Map<string, GitObject>();
    private cacheBytes = 0;

    constructor(
        private readonly fs: RepoFs,
        private readonly gitdir: string
    ) {}

    private loosePath(oid: string): string {
        return `${this.gitdir}/objects/${oid.slice(0, 2)}/${oid.slice(2)}`;
    }

    get packDir(): string {
        return `${this.gitdir}/objects/pack`;
    }

    /** Forget the pack list, e.g. after a fetch added a pack. */
    invalidatePacks(): void {
        for (const p of this.packs ?? []) p.reader.free();
        this.packs = undefined;
    }

    private async loadPacks(): Promise<Pack[]> {
        if (this.packs) return this.packs;
        const { files } = await this.fs.list(this.packDir);
        const packs: Pack[] = [];
        for (const f of files) {
            if (!f.endsWith(".idx")) continue;
            const name = f.slice(0, -4);
            const path = `${this.packDir}/${name}.pack`;
            const stat = await this.fs.stat(path);
            const idx = await this.fs.read(`${this.packDir}/${f}`);
            if (!stat || !idx) continue;
            packs.push({
                name,
                path,
                size: stat.size,
                reader: new PackReader(idx, stat.size, 8 << 20),
                verified: false,
                lock: Promise.resolve(),
            });
        }
        this.packs = packs;
        return packs;
    }

    private async findPack(oid: string): Promise<Pack | undefined> {
        const find = (packs: Pack[]) => packs.find((p) => p.reader.has(oid));
        const hit = find(await this.loadPacks());
        if (hit) return hit;
        // Another process (e.g. a sync tool) may have added packs.
        this.invalidatePacks();
        return find(await this.loadPacks());
    }

    private withPack<T>(pack: Pack, fn: () => Promise<T>): Promise<T> {
        const run = pack.lock.then(fn, fn);
        pack.lock = run.catch(() => undefined);
        return run;
    }

    private async readPacked(pack: Pack, oid: string): Promise<GitObject> {
        return this.withPack(pack, async () => {
            if (!pack.verified) {
                const trailer = await this.fs.readRange(
                    pack.path,
                    pack.size,
                    pack.size - 20,
                    20
                );
                const sum = Array.from(trailer, (b) =>
                    b.toString(16).padStart(2, "0")
                ).join("");
                if (sum !== pack.reader.pack_checksum_hex()) {
                    throw new Error(
                        `Packfile ${pack.name} does not match its index`
                    );
                }
                pack.verified = true;
            }
            const r = pack.reader;
            r.begin(oid);
            for (let req = r.next_read(); req; req = r.next_read()) {
                for await (const part of this.fs.readRangeParts(
                    pack.path,
                    pack.size,
                    req[0]!,
                    req[1]!
                )) {
                    r.provide_part(part);
                }
                r.provide_end();
            }
            const data = r.read_data(0, r.len());
            const type = r.kind() as ObjectType;
            r.release();
            return { type, data };
        });
    }

    private async readLoose(oid: string): Promise<GitObject | null> {
        const raw = await this.fs.read(this.loosePath(oid));
        if (!raw) return null;
        const bytes = inflate(raw);
        const nul = bytes.indexOf(0);
        const [type, size] = decoder.decode(bytes.subarray(0, nul)).split(" ");
        const data = bytes.subarray(nul + 1);
        if (Number(size) !== data.length) {
            throw new Error(`Corrupt loose object ${oid}`);
        }
        return { type: type as ObjectType, data };
    }

    async read(oid: string): Promise<GitObject> {
        const cached = this.cache.get(oid);
        if (cached) return cached;
        let obj = await this.readLoose(oid);
        if (!obj) {
            const pack = await this.findPack(oid);
            if (!pack) throw new NotFoundError(`object ${oid}`);
            obj = await this.readPacked(pack, oid);
        }
        if (obj.type !== "blob" && obj.data.length <= CACHE_MAX_OBJECT) {
            this.cache.set(oid, obj);
            this.cacheBytes += obj.data.length;
            while (this.cacheBytes > CACHE_LIMIT) {
                const [k, v] = this.cache.entries().next().value!;
                this.cache.delete(k);
                this.cacheBytes -= v.data.length;
            }
        }
        return obj;
    }

    async has(oid: string): Promise<boolean> {
        if (this.cache.has(oid)) return true;
        if (await this.fs.exists(this.loosePath(oid))) return true;
        return (await this.findPack(oid)) !== undefined;
    }

    /** Store an object (loose) and return its id. */
    async write(type: ObjectType, data: Uint8Array): Promise<string> {
        const oid = hash_object(type, data);
        if (await this.has(oid)) return oid;
        const header = encoder.encode(`${type} ${data.length}\0`);
        const full = new Uint8Array(header.length + data.length);
        full.set(header);
        full.set(data, header.length);
        await this.fs.write(this.loosePath(oid), deflate(full));
        return oid;
    }

    /** Full oid for an abbreviated one (at least 4 hex digits). */
    async expand(prefix: string): Promise<string> {
        prefix = prefix.toLowerCase();
        const matches = new Set<string>();
        const dir = `${this.gitdir}/objects/${prefix.slice(0, 2)}`;
        for (const f of (await this.fs.list(dir)).files) {
            const oid = prefix.slice(0, 2) + f;
            if (oid.startsWith(prefix)) matches.add(oid);
        }
        for (const p of await this.loadPacks()) {
            for (const oid of p.reader.oids_with_prefix(prefix))
                matches.add(oid);
        }
        if (matches.size === 1) return [...matches][0]!;
        if (matches.size === 0) throw new NotFoundError(`object ${prefix}`);
        throw new Error(`Short object ID ${prefix} is ambiguous`);
    }

    async readTyped(oid: string, type: ObjectType): Promise<Uint8Array> {
        const obj = await this.read(oid);
        if (obj.type !== type) {
            throw new Error(`Object ${oid} is a ${obj.type}, not a ${type}`);
        }
        return obj.data;
    }

    async readCommit(oid: string): Promise<Commit> {
        return parseCommit(
            await this.readTyped(await this.peel(oid, "commit"), "commit")
        );
    }

    async readTree(oid: string): Promise<TreeEntry[]> {
        return parseTree(
            await this.readTyped(await this.peel(oid, "tree"), "tree")
        );
    }

    /** Follow tags (and commit → tree) until an object of `type`. */
    async peel(oid: string, type: ObjectType): Promise<string> {
        for (let depth = 0; depth < 32; depth++) {
            const obj = await this.read(oid);
            if (obj.type === type) return oid;
            if (obj.type === "tag") {
                oid = parseTag(obj.data).object;
            } else if (obj.type === "commit" && type === "tree") {
                oid = parseCommit(obj.data).tree;
            } else {
                throw new Error(
                    `Object ${oid} is a ${obj.type}, not a ${type}`
                );
            }
        }
        throw new Error(`Too many levels of tags at ${oid}`);
    }
}
