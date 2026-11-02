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
    constructor(readonly filepaths: string[]) {
        super(
            `Your local changes to the following files would be overwritten by checkout: ${filepaths.join(", ")}`
        );
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
    opts: { force?: boolean; filepaths?: string[] } = {}
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

    if (!opts.force) {
        const blocked: string[] = [];
        for (const { path } of changes) {
            const before = fromFlat.get(path);
            const entry = index.entries.get(path);
            if (index.conflicts.has(path)) {
                blocked.push(path);
                continue;
            }
            const indexClean = before
                ? entry?.oid === before.oid
                : entry === undefined;
            if (!indexClean) {
                blocked.push(path);
                continue;
            }
            const w = await repo.workdirOid(path, entry, indexMtime);
            if (before) {
                // A tracked file must be unmodified (or already deleted).
                if (w && w.oid !== before.oid) blocked.push(path);
            } else if (w) {
                // An untracked file is in the way, unless it is ignored or
                // already identical to what we would write.
                const after = toFlat.get(path);
                if (w.oid !== after?.oid && !(await ignore.isIgnored(path)))
                    blocked.push(path);
            }
        }
        if (blocked.length > 0) throw new CheckoutConflictError(blocked);
    }

    const emptied = new Set<string>();
    for (const { path } of changes) {
        const after = toFlat.get(path);
        const vaultPath = repo.vaultPath(path);
        if (!after) {
            await repo.fs.remove(vaultPath);
            index.entries.delete(path);
            index.conflicts.delete(path);
            const slash = path.lastIndexOf("/");
            if (slash > 0) emptied.add(path.slice(0, slash));
            continue;
        }
        if (after.mode === MODE_GITLINK || after.mode === MODE_SYMLINK) {
            // Not representable in a vault; keep the index in step only.
            index.entries.set(path, entryFor(path, after, null));
            continue;
        }
        const data = await repo.objects.readTyped(after.oid, "blob");
        const current = await repo.fs.read(vaultPath);
        if (!current || hash_object("blob", current) !== after.oid) {
            // A directory may sit where the file goes (tree became blob).
            const stat = await repo.fs.stat(vaultPath);
            if (stat?.type === "folder") await repo.fs.rmdir(vaultPath, true);
            await repo.fs.write(vaultPath, data);
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
    await pruneEmptyDirs(repo, emptied);
    return changes;
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
