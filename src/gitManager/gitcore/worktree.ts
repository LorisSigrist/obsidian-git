// Index and working-tree mutations: staging, unstaging, restoring, committing.

import { NotFoundError, UnmergedPathsError } from "./errors";
import { statFields, type GitIndex, type IndexEntry } from "./gitIndex";
import type { IgnoreRules } from "./ignore";
import {
    MODE_TREE,
    localTimezone,
    serializeCommit,
    serializeTree,
    type Person,
    type TreeEntry,
} from "./model";
import type { FileStat } from "./repoFs";
import type { Repository } from "./repository";
import { hash_object } from "./wasm";

function newEntry(
    path: string,
    oid: string,
    mode: number,
    stat?: FileStat
): IndexEntry {
    return {
        path,
        oid,
        mode,
        ...(stat
            ? statFields(stat)
            : {
                  ctimeSec: 0,
                  ctimeNsec: 0,
                  mtimeSec: 0,
                  mtimeNsec: 0,
                  size: 0,
              }),
        dev: 0,
        ino: 0,
        uid: 0,
        gid: 0,
        stage: 0,
        assumeValid: false,
        skipWorktree: false,
        intentToAdd: false,
    };
}

function isUnder(path: string, dir: string): boolean {
    return (
        dir === "" || dir === "." || path === dir || path.startsWith(dir + "/")
    );
}

/**
 * Stage the working-tree state of `paths` (files or directories): new and
 * modified files are added, missing ones removed. Untracked ignored files are
 * skipped, as `git add` without `--force` would.
 */
export async function stagePaths(
    repo: Repository,
    index: GitIndex,
    paths: string[],
    ignore: IgnoreRules
): Promise<void> {
    for (const path of paths) {
        const stat = await repo.fs.stat(repo.vaultPath(path));
        if (stat?.type === "folder") {
            const files = await repo.workdirFiles(index, ignore, [path]);
            const tracked = [
                ...index.entries.keys(),
                ...index.conflicts.keys(),
            ];
            const present = new Set(files);
            for (const f of files) await stageFile(repo, index, f, ignore);
            for (const t of tracked) {
                if (isUnder(t, path) && !present.has(t)) unstageEntry(index, t);
            }
        } else if (stat) {
            await stageFile(repo, index, path, ignore);
        } else {
            unstageEntry(index, path);
        }
    }
}

async function stageFile(
    repo: Repository,
    index: GitIndex,
    path: string,
    ignore: IgnoreRules
): Promise<void> {
    const existing = index.entries.get(path);
    const tracked = existing !== undefined || index.conflicts.has(path);
    if (!tracked && (await ignore.isIgnored(path))) return;
    const vaultPath = repo.vaultPath(path);
    const data = await repo.fs.read(vaultPath);
    const stat = await repo.fs.stat(vaultPath);
    if (!data || !stat) {
        unstageEntry(index, path);
        return;
    }
    const oid = await repo.objects.write("blob", data);
    const mode = existing?.mode === 0o100755 ? 0o100755 : 0o100644;
    index.conflicts.delete(path);
    index.entries.set(path, newEntry(path, oid, mode, stat));
}

/** Remove a path from the index entirely (`git rm --cached`). */
export function unstageEntry(index: GitIndex, path: string): void {
    index.entries.delete(path);
    index.conflicts.delete(path);
}

/**
 * Reset index entries to their state in HEAD (`git reset -- <paths>`), keeping
 * the working tree. Paths may be directories.
 */
export async function resetPaths(
    repo: Repository,
    index: GitIndex,
    paths: string[]
): Promise<void> {
    // No filters would mean "everything" below.
    if (paths.length === 0) return;
    let headTree: string | undefined;
    try {
        headTree = await repo.commitTree("HEAD");
    } catch (e) {
        if (!(e instanceof NotFoundError)) throw e;
    }
    const head = await repo.flatten(headTree, paths);
    const touched = new Set<string>();
    for (const p of [...index.entries.keys(), ...index.conflicts.keys()]) {
        if (paths.some((dir) => isUnder(p, dir))) touched.add(p);
    }
    for (const p of head.keys()) touched.add(p);
    for (const path of touched) {
        const h = head.get(path);
        if (!h) {
            unstageEntry(index, path);
            continue;
        }
        const current = index.entries.get(path);
        if (
            current &&
            current.oid === h.oid &&
            current.mode === parseInt(h.mode, 8)
        ) {
            continue;
        }
        // Keep the stat cache valid if the working file is HEAD's version.
        const stat = await repo.fs.stat(repo.vaultPath(path));
        let fileStat: FileStat | undefined;
        if (stat?.type === "file") {
            const data = await repo.fs.read(repo.vaultPath(path));
            if (data && hash_object("blob", data) === h.oid) fileStat = stat;
        }
        index.conflicts.delete(path);
        index.entries.set(
            path,
            newEntry(path, h.oid, parseInt(h.mode, 8), fileStat)
        );
    }
}

/**
 * Overwrite working-tree files with their staged version (`git checkout --
 * <paths>`). Paths not in the index are left alone.
 */
export async function restoreFromIndex(
    repo: Repository,
    index: GitIndex,
    paths: string[]
): Promise<void> {
    for (const [path, entry] of index.entries) {
        if (!paths.some((dir) => isUnder(path, dir))) continue;
        if (entry.mode === 0o160000 || entry.mode === 0o120000) continue;
        const vaultPath = repo.vaultPath(path);
        const data = await repo.objects.readTyped(entry.oid, "blob");
        const current = await repo.fs.read(vaultPath);
        if (!current || hash_object("blob", current) !== entry.oid) {
            await repo.fs.write(vaultPath, data);
        }
        const stat = await repo.fs.stat(vaultPath);
        if (stat) index.entries.set(path, { ...entry, ...statFields(stat) });
    }
}

/** Changes from the index to the working tree (`git diff --name-status`, plus untracked). */
export async function unstagedChanges(
    repo: Repository,
    index: GitIndex,
    indexMtime: number,
    ignore: IgnoreRules,
    base?: string
): Promise<{ path: string; type: "A" | "M" | "D" }[]> {
    const filters = base && base !== "." ? [base] : undefined;
    const files = new Set(await repo.workdirFiles(index, ignore, filters));
    const out: { path: string; type: "A" | "M" | "D" }[] = [];
    for (const [path, entry] of index.entries) {
        if (filters && !isUnder(path, base!)) continue;
        if (entry.mode === 0o160000 || entry.mode === 0o120000) continue;
        if (!files.has(path)) {
            out.push({ path, type: "D" });
            continue;
        }
        const w = await repo.workdirOid(path, entry, indexMtime);
        if (!w) out.push({ path, type: "D" });
        else if (w.oid !== entry.oid) out.push({ path, type: "M" });
    }
    // Conflicted paths always need staging to resolve them.
    for (const path of index.conflicts.keys()) {
        if (filters && !isUnder(path, base!)) continue;
        out.push({ path, type: files.has(path) ? "M" : "D" });
    }
    for (const path of files) {
        if (index.entries.has(path) || index.conflicts.has(path)) continue;
        if (await ignore.isIgnored(path)) continue;
        out.push({ path, type: "A" });
    }
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** Write the trees for the index's stage-0 entries and return the root tree id. */
export async function writeTree(
    repo: Repository,
    index: GitIndex
): Promise<string> {
    if (index.conflicts.size > 0) {
        throw new UnmergedPathsError([...index.conflicts.keys()].sort());
    }
    interface Dir {
        files: TreeEntry[];
        dirs: Map<string, Dir>;
    }
    const root: Dir = { files: [], dirs: new Map() };
    for (const e of index.entries.values()) {
        if (e.intentToAdd) continue;
        const parts = e.path.split("/");
        let dir = root;
        for (const part of parts.slice(0, -1)) {
            let next = dir.dirs.get(part);
            if (!next) {
                next = { files: [], dirs: new Map() };
                dir.dirs.set(part, next);
            }
            dir = next;
        }
        dir.files.push({
            mode: e.mode.toString(8),
            name: parts[parts.length - 1]!,
            oid: e.oid,
        });
    }
    const write = async (dir: Dir): Promise<string> => {
        const entries = [...dir.files];
        for (const [name, sub] of dir.dirs) {
            entries.push({ mode: MODE_TREE, name, oid: await write(sub) });
        }
        return repo.objects.write("tree", serializeTree(entries));
    };
    return write(root);
}

export function person(name: string, email: string, date = new Date()): Person {
    return {
        name,
        email,
        timestamp: Math.floor(date.getTime() / 1000),
        timezone: localTimezone(date),
    };
}

/** Normalize a commit message the way `git commit` does (trailing whitespace, final newline). */
export function cleanMessage(message: string): string {
    return message.replace(/[ \t]+$/gm, "").replace(/\s+$/, "") + "\n";
}

export async function writeCommit(
    repo: Repository,
    opts: {
        tree: string;
        parents: string[];
        message: string;
        author: Person;
        committer: Person;
    }
): Promise<string> {
    return repo.objects.write(
        "commit",
        serializeCommit({ ...opts, extraHeaders: [] })
    );
}

/** Point HEAD (its branch, or HEAD itself when detached) at `oid`. */
export async function updateHead(repo: Repository, oid: string): Promise<void> {
    const target = await repo.refs.headTarget();
    await repo.refs.write(target ?? "HEAD", oid);
}
