// Moving the working tree and index from one tree to another, as `git checkout` does.

import { GitError } from "./errors";
import { statFields, type GitIndex, type IndexEntry } from "./gitIndex";
import type { IgnoreRules } from "./ignore";
import { MODE_GITLINK, MODE_SYMLINK } from "./model";
import type { Change, FlatEntry, Repository } from "./repository";
import { modeString } from "./repository";
import { hash_object } from "./wasm";
import { settledStat } from "./worktree";

/** Local changes or untracked files that a checkout would overwrite. */
export class CheckoutConflictError extends GitError {
    constructor(
        readonly filepaths: string[],
        reason = "your local changes to these files would be overwritten by checkout"
    ) {
        super(`Cannot check out: ${reason}: ${filepaths.join(", ")}`);
    }
}

function entryFor(
    path: string,
    target: FlatEntry,
    stat: { mtime: number; ctime: number; size: number } | null
): IndexEntry {
    return {
        path,
        oid: target.oid,
        mode: parseInt(target.mode, 8),
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

/**
 * Bring the working tree and `index` from tree `from` to tree `to`.
 *
 * Only paths that differ between the two trees are touched, so unrelated local
 * changes survive. Without `force`, a path is refused if its index or working
 * file differs from `from` (local work would be lost), or if it is an
 * untracked, non-ignored file in the way of a file being created.
 * With `filepaths`, only changes under those paths are applied.
 *
 * The caller writes the index afterwards.
 */
export async function checkoutTree(
    repo: Repository,
    index: GitIndex,
    indexMtime: number,
    ignore: IgnoreRules,
    from: string | undefined,
    to: string | undefined,
    opts: {
        force?: boolean;
        filepaths?: string[];
        /** Only run the checks: throw if files are in the way, write nothing. */
        checkOnly?: boolean;
        /** Called before each file is written: (written so far, total). */
        onProgress?: (done: number, total: number) => void;
    } = {}
): Promise<Change[]> {
    const changes = await repo.diffTrees(from, to, opts.filepaths);
    if (changes.length === 0) return changes;
    const fromFlat = await repo.flatten(
        from,
        changes.map((c) => c.path)
    );
    const toFlat = await repo.flatten(
        to,
        changes.map((c) => c.path)
    );

    // Names that only differ in case refer to the same file on iOS, Android
    // and macOS storage, so a case-only rename must not look like a collision.
    const deletedFolded = new Set(
        changes
            .filter((c) => !toFlat.has(c.path))
            .map((c) => c.path.toLowerCase())
    );

    if (!opts.force) {
        if (!opts.filepaths && index.conflicts.size > 0) {
            throw new CheckoutConflictError(
                [...index.conflicts.keys()].sort(),
                "you need to resolve your current index first"
            );
        }
        const blocked = new Set<string>();
        for (const { path } of changes) {
            const before = fromFlat.get(path);
            const after = toFlat.get(path);
            const entry = index.entries.get(path);
            if (index.conflicts.has(path)) {
                blocked.add(path);
                continue;
            }
            const indexClean = before
                ? entry?.oid === before.oid
                : entry === undefined;
            if (!indexClean) {
                blocked.add(path);
                continue;
            }
            if (before) {
                // A tracked file must be unmodified (or already deleted).
                const w = await repo.workdirOid(path, entry, indexMtime);
                if (w && w.oid !== before.oid) blocked.add(path);
                continue;
            }
            if (!after || deletedFolded.has(path.toLowerCase())) continue;
            // Something untracked may be in the way of the new file: a file,
            // a folder with untracked files, or a file where a parent folder
            // must go. Ignored files are replaced, as git does.
            const stat = await repo.fs.stat(repo.vaultPath(path));
            if (stat?.type === "file") {
                const w = await repo.workdirOid(path, entry, indexMtime);
                if (w && w.oid !== after.oid && !(await ignore.isIgnored(path)))
                    blocked.add(path);
            } else if (stat?.type === "folder") {
                for (const f of await listAll(repo, path)) {
                    if (!fromFlat.has(f) && !(await ignore.isIgnored(f)))
                        blocked.add(path);
                }
            }
            const parts = path.split("/");
            for (let i = 1; i < parts.length; i++) {
                const dir = parts.slice(0, i).join("/");
                const s = await repo.fs.stat(repo.vaultPath(dir));
                if (
                    s?.type === "file" &&
                    !fromFlat.has(dir) &&
                    !(await ignore.isIgnored(dir))
                )
                    blocked.add(path);
            }
        }
        if (blocked.size > 0)
            throw new CheckoutConflictError([...blocked].sort());
    }
    if (opts.checkOnly) return changes;

    // Deletions first: a folder being replaced by a file, or a case-only
    // rename, needs the old entries gone before the new ones are written.
    const emptied = new Set<string>();
    for (const { path } of changes) {
        if (toFlat.has(path)) continue;
        await repo.fs.remove(repo.vaultPath(path));
        index.entries.delete(path);
        index.conflicts.delete(path);
        const slash = path.lastIndexOf("/");
        if (slash > 0) emptied.add(path.slice(0, slash));
    }
    await pruneEmptyDirs(repo, emptied);

    const toWrite = changes.filter((c) => toFlat.has(c.path)).length;
    let written = 0;
    for (const { path } of changes) {
        const after = toFlat.get(path);
        if (!after) continue;
        opts.onProgress?.(written++, toWrite);
        const vaultPath = repo.vaultPath(path);
        if (after.mode === MODE_GITLINK || after.mode === MODE_SYMLINK) {
            // Not representable in a vault; keep the index in step only.
            index.entries.set(path, entryFor(path, after, null));
            continue;
        }
        // Clear what the checks allowed to be replaced: leftover (ignored)
        // content where the file goes, or a file where a folder must go.
        const parts = path.split("/");
        for (let i = 1; i < parts.length; i++) {
            const dir = repo.vaultPath(parts.slice(0, i).join("/"));
            if ((await repo.fs.stat(dir))?.type === "file") {
                await repo.fs.remove(dir);
            }
        }
        const stat = await repo.fs.stat(vaultPath);
        if (stat?.type === "folder") await repo.fs.rmdir(vaultPath, true);
        const current =
            stat?.type === "file" ? await repo.fs.read(vaultPath) : null;
        if (!current || hash_object("blob", current) !== after.oid) {
            await repo.fs.write(
                vaultPath,
                await repo.objects.readTyped(after.oid, "blob")
            );
        }
        index.conflicts.delete(path);
        index.entries.set(
            path,
            entryFor(
                path,
                after,
                (await settledStat(repo, vaultPath, after.oid)) ?? null
            )
        );
    }
    return changes;
}

/** Every file below a working-tree folder, as repository paths. */
async function listAll(repo: Repository, dir: string): Promise<string[]> {
    const out: string[] = [];
    const walk = async (d: string) => {
        const { files, folders } = await repo.fs.list(repo.vaultPath(d));
        for (const f of files) out.push(`${d}/${f}`);
        for (const f of folders) await walk(`${d}/${f}`);
    };
    await walk(dir);
    return out;
}

/** Remove directories left empty by deletions, walking up toward the root. */
async function pruneEmptyDirs(
    repo: Repository,
    dirs: Set<string>
): Promise<void> {
    const sorted = [...dirs].sort((a, b) => b.length - a.length);
    const done = new Set<string>();
    for (let dir of sorted) {
        while (dir && !done.has(dir)) {
            done.add(dir);
            const { files, folders } = await repo.fs.list(repo.vaultPath(dir));
            if (files.length > 0 || folders.length > 0) break;
            await repo.fs.rmdir(repo.vaultPath(dir), false);
            const slash = dir.lastIndexOf("/");
            dir = slash > 0 ? dir.slice(0, slash) : "";
        }
    }
}

/** Whether index entry and flat tree entry describe the same content. */
export function sameEntry(e: IndexEntry | undefined, f: FlatEntry | undefined) {
    if (!e || !f) return e === undefined && f === undefined;
    return e.oid === f.oid && modeString(e.mode) === f.mode;
}
