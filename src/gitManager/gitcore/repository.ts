import { NotFoundError } from "./errors";
import { GitConfig } from "./config";
import { GitIndex, statMatches, type IndexEntry } from "./gitIndex";
import { IgnoreRules } from "./ignore";
import {
    MODE_GITLINK,
    MODE_SYMLINK,
    MODE_TREE,
    type Commit,
    type TreeEntry,
} from "./model";
import { ObjectDb } from "./objects";
import { Refs } from "./refs";
import { RepoFs, type FileStat, type RangeReader } from "./repoFs";
import { hash_object, loadWasm } from "./wasm";
import type { Vault } from "obsidian";

export interface RepoOptions {
    /** Vault path of the repository root; "" when it is the vault root. */
    root: string;
    /** Vault path of the git directory. */
    gitdir: string;
    rangeReader?: RangeReader;
}

export interface FlatEntry {
    oid: string;
    mode: string;
}

export interface Change {
    path: string;
    type: "A" | "M" | "D";
}

/**
 * One file's state, as isomorphic-git's statusMatrix reported it:
 * head 0 absent / 1 present; workdir 0 absent / 1 same as HEAD / 2 different;
 * stage 0 absent / 1 same as HEAD / 2 same as workdir / 3 different from both.
 */
export type StatusRow = [string, 0 | 1, 0 | 1 | 2, 0 | 1 | 2 | 3];

export interface LoggedCommit {
    oid: string;
    commit: Commit;
}

const HEX = /^[0-9a-f]{4,40}$/i;

/** Whether `path` is inside (or is) one of the prefix filters, or an ancestor of one. */
function worthWalking(path: string, filters?: string[]): boolean {
    if (!filters || filters.length === 0) return true;
    return filters.some((f) => {
        const prefix = f.replace(/\/$/, "");
        if (prefix === "" || prefix === ".") return true;
        return (
            path === prefix ||
            path.startsWith(prefix + "/") ||
            prefix.startsWith(path + "/")
        );
    });
}

function inFilters(path: string, filters?: string[]): boolean {
    if (!filters || filters.length === 0) return true;
    return filters.some((f) => {
        const prefix = f.replace(/\/$/, "");
        return (
            prefix === "" ||
            prefix === "." ||
            path === prefix ||
            path.startsWith(prefix + "/")
        );
    });
}

export function modeString(mode: number): string {
    return mode.toString(8);
}

export class Repository {
    readonly fs: RepoFs;
    readonly objects: ObjectDb;
    readonly refs: Refs;
    readonly root: string;
    readonly gitdir: string;

    constructor(vault: Vault, opts: RepoOptions) {
        this.root = opts.root;
        this.gitdir = opts.gitdir;
        this.fs = new RepoFs(vault, opts.rangeReader);
        this.objects = new ObjectDb(this.fs, this.gitdir);
        this.refs = new Refs(this.fs, this.gitdir);
    }

    /** Must be awaited once before using the repository. */
    async ready(): Promise<this> {
        await loadWasm();
        return this;
    }

    /** Vault path of a repository-relative path. */
    vaultPath(rel: string): string {
        if (!this.root) return rel;
        return rel === "" || rel === "." ? this.root : `${this.root}/${rel}`;
    }

    async exists(): Promise<boolean> {
        return this.fs.exists(`${this.gitdir}/HEAD`);
    }

    async readConfig(): Promise<GitConfig> {
        return new GitConfig(
            (await this.fs.readText(`${this.gitdir}/config`)) ?? ""
        );
    }

    async writeConfig(config: GitConfig): Promise<void> {
        await this.fs.write(`${this.gitdir}/config`, config.toString());
    }

    async readIndex(): Promise<{ index: GitIndex; mtime: number }> {
        const path = `${this.gitdir}/index`;
        const data = await this.fs.read(path);
        if (!data) return { index: new GitIndex(), mtime: 0 };
        const stat = await this.fs.stat(path);
        return { index: GitIndex.parse(data), mtime: stat?.mtime ?? 0 };
    }

    async writeIndex(index: GitIndex): Promise<void> {
        await this.fs.write(`${this.gitdir}/index`, index.serialize());
    }

    /**
     * Resolve a revision to an oid: a ref name, full or abbreviated oid,
     * optionally followed by `~n` / `^n` steps (as in `HEAD~2^2`).
     */
    async resolve(rev: string): Promise<string> {
        const m = /^(.*?)((?:[~^]\d*)*)$/.exec(rev)!;
        const base = m[1]!;
        let oid: string;
        try {
            oid = await this.refs.resolve(base);
        } catch (e) {
            if (e instanceof NotFoundError && HEX.test(base)) {
                oid = await this.objects.expand(base);
            } else {
                throw e;
            }
        }
        for (const step of m[2]!.match(/[~^]\d*/g) ?? []) {
            const n = step.length > 1 ? Number(step.slice(1)) : 1;
            if (step.startsWith("~")) {
                for (let i = 0; i < n; i++) {
                    oid = await this.nthParent(oid, 1, rev);
                }
            } else if (n > 0) {
                oid = await this.nthParent(oid, n, rev);
            }
        }
        return oid;
    }

    private async nthParent(
        oid: string,
        n: number,
        rev: string
    ): Promise<string> {
        const commit = await this.objects.readCommit(oid);
        const parent = commit.parents[n - 1];
        if (!parent) throw new NotFoundError(`revision ${rev}`);
        return parent;
    }

    async resolveCommit(ref: string): Promise<string> {
        return this.objects.peel(await this.resolve(ref), "commit");
    }

    async headOid(): Promise<string | undefined> {
        try {
            return await this.resolveCommit("HEAD");
        } catch (e) {
            if (e instanceof NotFoundError) return undefined;
            throw e;
        }
    }

    async commitTree(ref: string): Promise<string> {
        return (await this.objects.readCommit(await this.resolveCommit(ref)))
            .tree;
    }

    /** All non-tree entries under a tree, by repository path. */
    async flatten(
        treeOid: string | undefined,
        filters?: string[]
    ): Promise<Map<string, FlatEntry>> {
        const out = new Map<string, FlatEntry>();
        const walk = async (oid: string, prefix: string) => {
            for (const e of await this.objects.readTree(oid)) {
                const path = prefix ? `${prefix}/${e.name}` : e.name;
                if (!worthWalking(path, filters)) continue;
                if (e.mode === MODE_TREE) await walk(e.oid, path);
                else if (inFilters(path, filters))
                    out.set(path, { oid: e.oid, mode: e.mode });
            }
        };
        if (treeOid) await walk(treeOid, "");
        return out;
    }

    /** The entry at `path` in a tree, or undefined. */
    async treeEntryAt(
        treeOid: string,
        path: string
    ): Promise<TreeEntry | undefined> {
        let oid = treeOid;
        const parts = path.split("/");
        for (let i = 0; i < parts.length; i++) {
            const entry = (await this.objects.readTree(oid)).find(
                (e) => e.name === parts[i]
            );
            if (!entry) return undefined;
            if (i === parts.length - 1) return entry;
            if (entry.mode !== MODE_TREE) return undefined;
            oid = entry.oid;
        }
        return undefined;
    }

    /** Contents of `path` at a commit, or undefined if it does not exist there. */
    async readBlobAt(
        commitish: string,
        path: string
    ): Promise<Uint8Array | undefined> {
        const entry = await this.treeEntryAt(
            await this.commitTree(commitish),
            path
        );
        if (!entry || entry.mode === MODE_TREE) return undefined;
        return this.objects.readTyped(entry.oid, "blob");
    }

    /** Changes from tree `a` to tree `b` (either may be undefined = empty). */
    async diffTrees(
        a: string | undefined,
        b: string | undefined,
        filters?: string[]
    ): Promise<Change[]> {
        const out: Change[] = [];
        const all = async (oid: string, prefix: string, type: "A" | "D") => {
            for (const [path] of await this.flatten(oid)) {
                const full = `${prefix}/${path}`;
                if (inFilters(full, filters)) out.push({ path: full, type });
            }
        };
        const walk = async (
            ta: string | undefined,
            tb: string | undefined,
            prefix: string
        ) => {
            const ea = ta ? await this.objects.readTree(ta) : [];
            const eb = tb ? await this.objects.readTree(tb) : [];
            const byName = new Map<string, [TreeEntry?, TreeEntry?]>();
            for (const e of ea) byName.set(e.name, [e, undefined]);
            for (const e of eb)
                byName.set(e.name, [byName.get(e.name)?.[0], e]);
            for (const [name, [x, y]] of byName) {
                const path = prefix ? `${prefix}/${name}` : name;
                if (!worthWalking(path, filters)) continue;
                const xTree = x?.mode === MODE_TREE;
                const yTree = y?.mode === MODE_TREE;
                if (xTree && yTree) {
                    if (x.oid !== y.oid) await walk(x.oid, y.oid, path);
                    continue;
                }
                if (xTree) await all(x.oid, path, "D");
                if (yTree) await all(y.oid, path, "A");
                const xFile = x && !xTree ? x : undefined;
                const yFile = y && !yTree ? y : undefined;
                if (!inFilters(path, filters)) continue;
                if (xFile && yFile) {
                    if (xFile.oid !== yFile.oid || xFile.mode !== yFile.mode)
                        out.push({ path, type: "M" });
                } else if (xFile) {
                    out.push({ path, type: "D" });
                } else if (yFile) {
                    out.push({ path, type: "A" });
                }
            }
        };
        await walk(a, b, "");
        return out.sort((p, q) =>
            p.path < q.path ? -1 : p.path > q.path ? 1 : 0
        );
    }

    /** Changes from a tree to the index (what `git diff --cached` shows). */
    async diffTreeIndex(
        treeOid: string | undefined,
        index: GitIndex,
        filters?: string[]
    ): Promise<Change[]> {
        const head = await this.flatten(treeOid, filters);
        const out: Change[] = [];
        for (const [path, e] of index.entries) {
            if (!inFilters(path, filters)) continue;
            const h = head.get(path);
            if (!h) out.push({ path, type: "A" });
            else if (h.oid !== e.oid || h.mode !== modeString(e.mode))
                out.push({ path, type: "M" });
        }
        for (const path of head.keys()) {
            if (!index.entries.has(path) && !index.conflicts.has(path))
                out.push({ path, type: "D" });
        }
        return out.sort((p, q) =>
            p.path < q.path ? -1 : p.path > q.path ? 1 : 0
        );
    }

    async ignoreRules(): Promise<IgnoreRules> {
        const ignoreCase = (await this.readConfig()).get("core.ignorecase");
        return new IgnoreRules(
            this.fs,
            this.root,
            this.gitdir,
            ignoreCase === "true"
        );
    }

    /**
     * Files in the working tree, skipping the git directory, ignored
     * directories that contain no tracked files, submodules (gitlinks) and
     * other nested repositories.
     */
    async workdirFiles(
        index: GitIndex,
        ignore: IgnoreRules,
        filters?: string[]
    ): Promise<string[]> {
        const tracked = [...index.entries.keys(), ...index.conflicts.keys()];
        const hasTrackedUnder = (dir: string) =>
            tracked.some((p) => p.startsWith(dir + "/"));
        const gitlinks = new Set(
            [...index.entries.values()]
                .filter((e) => e.mode === 0o160000)
                .map((e) => e.path)
        );
        const files: string[] = [];
        const walk = async (dir: string) => {
            if (gitlinks.has(dir)) return;
            const { files: names, folders } = await this.fs.list(
                this.vaultPath(dir)
            );
            // A nested repository (its own .git file or folder) is not ours to walk.
            if (dir && (names.includes(".git") || folders.includes(".git"))) {
                return;
            }
            for (const name of names) {
                const path = dir ? `${dir}/${name}` : name;
                if (inFilters(path, filters)) files.push(path);
            }
            for (const name of folders) {
                const path = dir ? `${dir}/${name}` : name;
                if (name === ".git" || this.vaultPath(path) === this.gitdir)
                    continue;
                if (!worthWalking(path, filters)) continue;
                if (
                    (await ignore.isIgnored(path, true)) &&
                    !hasTrackedUnder(path)
                )
                    continue;
                await walk(path);
            }
        };
        await walk("");
        return files;
    }

    async hashWorkdirFile(path: string): Promise<string | undefined> {
        const data = await this.fs.read(this.vaultPath(path));
        return data ? hash_object("blob", data) : undefined;
    }

    /**
     * The blob id of a working tree file, from the index's stat cache when the
     * file looks untouched since it was staged.
     */
    async workdirOid(
        path: string,
        entry: IndexEntry | undefined,
        indexMtime: number
    ): Promise<{ oid: string; stat: FileStat } | undefined> {
        const stat = await this.fs.stat(this.vaultPath(path));
        if (!stat || stat.type !== "file") return undefined;
        // A file modified in the same instant the index was written may have
        // changed without its stat showing it ("racy git"), so hash it.
        if (entry && statMatches(entry, stat) && stat.mtime < indexMtime) {
            return { oid: entry.oid, stat };
        }
        const oid = await this.hashWorkdirFile(path);
        return oid ? { oid, stat } : undefined;
    }

    async statusMatrix(
        opts: {
            ref?: string;
            filepaths?: string[];
        } = {}
    ): Promise<StatusRow[]> {
        const filters = opts.filepaths;
        let headTree: string | undefined;
        try {
            headTree = await this.commitTree(opts.ref ?? "HEAD");
        } catch (e) {
            if (!(e instanceof NotFoundError)) throw e;
        }
        const head = await this.flatten(headTree, filters);
        const { index, mtime } = await this.readIndex();
        const ignore = await this.ignoreRules();
        const workdir = new Set(
            await this.workdirFiles(index, ignore, filters)
        );

        const paths = new Set<string>([...head.keys(), ...workdir]);
        for (const p of index.entries.keys())
            if (inFilters(p, filters)) paths.add(p);
        for (const p of index.conflicts.keys())
            if (inFilters(p, filters)) paths.add(p);

        const rows: StatusRow[] = [];
        for (const path of [...paths].sort()) {
            const h = head.get(path);
            const e = index.entries.get(path);
            const conflicted = index.conflicts.has(path);
            const inWorkdir = workdir.has(path);
            if (h?.mode === MODE_GITLINK || h?.mode === MODE_SYMLINK) continue;
            if (e && (e.mode === 0o160000 || e.mode === 0o120000)) continue;
            if (!h && !e && !conflicted) {
                // Untracked: no need to hash, only to know it is not ignored.
                if (!inWorkdir || (await ignore.isIgnored(path))) continue;
                rows.push([path, 0, 2, 0]);
                continue;
            }
            const w = inWorkdir
                ? await this.workdirOid(path, e, mtime)
                : undefined;
            const headBit = h ? 1 : 0;
            const workBit = !w ? 0 : w.oid === h?.oid ? 1 : 2;
            let stageBit: 0 | 1 | 2 | 3;
            if (conflicted) stageBit = 3;
            else if (!e) stageBit = 0;
            else if (e.oid === h?.oid) stageBit = 1;
            else if (e.oid === w?.oid) stageBit = 2;
            else stageBit = 3;
            rows.push([path, headBit, workBit, stageBit]);
        }
        return rows;
    }

    /**
     * Commits reachable from `ref`, newest committer date first (like
     * `git log`). With `file`, git's default history simplification applies:
     * a commit is shown only if the file differs from every parent, and when it
     * matches a parent only that parent's history is followed.
     */
    async log(
        ref = "HEAD",
        limit?: number,
        file?: string
    ): Promise<LoggedCommit[]> {
        const start = await this.resolveCommit(ref);
        const seen = new Set<string>([start]);
        const queue: LoggedCommit[] = [
            { oid: start, commit: await this.objects.readCommit(start) },
        ];
        const out: LoggedCommit[] = [];
        while (
            queue.length > 0 &&
            (limit === undefined || out.length < limit)
        ) {
            // Pop the newest commit; ties go to the one queued first.
            let best = 0;
            for (let i = 1; i < queue.length; i++) {
                if (
                    queue[i]!.commit.committer.timestamp >
                    queue[best]!.commit.committer.timestamp
                )
                    best = i;
            }
            const item = queue.splice(best, 1)[0]!;
            // In a shallow clone, parents beyond the boundary are absent.
            const parents: string[] = [];
            for (const p of item.commit.parents) {
                if (await this.objects.has(p)) parents.push(p);
            }
            let follow = parents;
            if (file) {
                const mine = (await this.treeEntryAt(item.commit.tree, file))
                    ?.oid;
                let sameAs: string | undefined;
                for (const p of parents) {
                    const theirs = (
                        await this.treeEntryAt(
                            (await this.objects.readCommit(p)).tree,
                            file
                        )
                    )?.oid;
                    if (theirs === mine) {
                        sameAs = p;
                        break;
                    }
                }
                if (sameAs) {
                    follow = [sameAs];
                } else if (parents.length > 0 || mine !== undefined) {
                    out.push(item);
                }
            } else {
                out.push(item);
            }
            for (const parent of follow) {
                if (seen.has(parent)) continue;
                seen.add(parent);
                queue.push({
                    oid: parent,
                    commit: await this.objects.readCommit(parent),
                });
            }
        }
        return out;
    }
}
