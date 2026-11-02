import { NotFoundError } from "./errors";
import type { RepoFs } from "./repoFs";

const OID = /^[0-9a-f]{40}$/;

interface PackedRefs {
    refs: Map<string, string>;
    lines: string[];
}

/** Loose refs, `packed-refs` and symbolic refs under the git directory. */
export class Refs {
    constructor(
        private readonly fs: RepoFs,
        private readonly gitdir: string
    ) {}

    private async packed(): Promise<PackedRefs> {
        const text = await this.fs.readText(`${this.gitdir}/packed-refs`);
        const refs = new Map<string, string>();
        const lines = text ? text.split("\n") : [];
        for (const line of lines) {
            if (line.startsWith("#") || line.startsWith("^")) continue;
            const m = /^([0-9a-f]{40}) (.+)$/.exec(line);
            if (m) refs.set(m[2]!, m[1]!);
        }
        return { refs, lines };
    }

    /** Raw value of a full ref: an oid or "ref: <target>"; null if missing. */
    async readRaw(ref: string): Promise<string | null> {
        const path = `${this.gitdir}/${ref}`;
        // A ref name can also be a directory of refs (refs/remotes/origin).
        if ((await this.fs.stat(path))?.type === "file") {
            const loose = await this.fs.readText(path);
            if (loose !== null) return loose.trim();
        }
        return (await this.packed()).refs.get(ref) ?? null;
    }

    /** Resolve a full ref name to an oid, following symbolic refs. */
    async resolveFull(ref: string): Promise<string | null> {
        for (let depth = 0; depth < 10; depth++) {
            const raw = await this.readRaw(ref);
            if (raw === null) return null;
            if (raw.startsWith("ref:")) {
                ref = raw.slice(4).trim();
                continue;
            }
            if (OID.test(raw)) return raw;
            return null;
        }
        throw new Error(`Symbolic ref loop at ${ref}`);
    }

    /** The full name a short ref refers to, by git's lookup rules; null if none. */
    async expand(name: string): Promise<string | null> {
        const candidates = [
            name,
            `refs/${name}`,
            `refs/tags/${name}`,
            `refs/heads/${name}`,
            `refs/remotes/${name}`,
            `refs/remotes/${name}/HEAD`,
        ];
        for (const c of candidates) {
            if (c !== "HEAD" && !c.startsWith("refs/") && !/^[A-Z_]+$/.test(c))
                continue;
            if ((await this.readRaw(c)) !== null) return c;
        }
        return null;
    }

    /** Resolve a short or full ref name to an oid; throws if it does not exist. */
    async resolve(name: string): Promise<string> {
        if (OID.test(name)) return name;
        const full = await this.expand(name);
        const oid = full ? await this.resolveFull(full) : null;
        if (!oid) throw new NotFoundError(`ref ${name}`);
        return oid;
    }

    /** The branch HEAD points to (short name), or undefined when detached/missing. */
    async currentBranch(): Promise<string | undefined> {
        const raw = await this.readRaw("HEAD");
        if (raw?.startsWith("ref: refs/heads/")) {
            return raw.slice("ref: refs/heads/".length).trim();
        }
        return undefined;
    }

    /** The full ref HEAD points to, or undefined when detached. */
    async headTarget(): Promise<string | undefined> {
        const raw = await this.readRaw("HEAD");
        return raw?.startsWith("ref:") ? raw.slice(4).trim() : undefined;
    }

    /**
     * An existing ref that would make `ref` impossible to create: one of its
     * parents (`refs/heads/a` blocks `refs/heads/a/b`) or a ref below it.
     */
    async clash(ref: string): Promise<string | undefined> {
        const parts = ref.split("/");
        for (let i = 2; i < parts.length; i++) {
            const parent = parts.slice(0, i).join("/");
            if ((await this.readRaw(parent)) !== null) return parent;
        }
        const below = await this.list(ref + "/");
        return below.length > 0 ? `${ref}/${below[0]}` : undefined;
    }

    async write(ref: string, oid: string): Promise<void> {
        if (!OID.test(oid)) throw new Error(`Invalid oid ${oid} for ${ref}`);
        await this.fs.write(`${this.gitdir}/${ref}`, `${oid}\n`);
    }

    async writeSymbolic(ref: string, target: string): Promise<void> {
        await this.fs.write(`${this.gitdir}/${ref}`, `ref: ${target}\n`);
    }

    async delete(ref: string): Promise<void> {
        await this.fs.remove(`${this.gitdir}/${ref}`);
        const { refs, lines } = await this.packed();
        if (!refs.has(ref)) return;
        const out: string[] = [];
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i]!;
            if (line.endsWith(` ${ref}`) && /^[0-9a-f]{40} /.test(line)) {
                // Drop its peeled line too.
                if (lines[i + 1]?.startsWith("^")) i++;
                continue;
            }
            out.push(line);
        }
        await this.fs.write(`${this.gitdir}/packed-refs`, out.join("\n"));
    }

    /** Names under `prefix` (e.g. "refs/heads/"), relative to it, sorted. */
    async list(prefix: string): Promise<string[]> {
        const names = new Set<string>();
        for (const ref of (await this.packed()).refs.keys()) {
            if (ref.startsWith(prefix)) names.add(ref.slice(prefix.length));
        }
        const walk = async (dir: string, rel: string) => {
            const { files, folders } = await this.fs.list(
                `${this.gitdir}/${dir}`
            );
            for (const f of files) {
                if (!f.endsWith(".lock")) names.add(rel + f);
            }
            for (const d of folders) await walk(`${dir}/${d}`, `${rel}${d}/`);
        };
        await walk(prefix.replace(/\/$/, ""), "");
        return [...names].sort();
    }
}
