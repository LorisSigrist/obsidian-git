// Three-way merge of trees, with line-based content merges for text files.

import diff3Merge from "diff3";
import { UnsupportedError } from "./errors";
import { MODE_TREE, serializeTree, type TreeEntry } from "./model";
import type { FlatEntry, Repository } from "./repository";

export type MergeStrategy = "none" | "ours" | "theirs";

export interface Conflict {
    path: string;
    base?: FlatEntry;
    ours?: FlatEntry;
    theirs?: FlatEntry;
    /** What to put in the working tree: text with conflict markers, or the surviving side. */
    worktree?: Uint8Array;
}

export interface TreeMergeResult {
    /** The merged files; conflicted paths hold our side (or theirs if ours is gone). */
    merged: Map<string, FlatEntry>;
    conflicts: Conflict[];
}

const encoder = new TextEncoder();

/** Strict and BOM-preserving, so a text merge never alters bytes it keeps. */
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** Decode UTF-8 text, or undefined when the bytes are not valid UTF-8. */
function decodeText(data: Uint8Array): string | undefined {
    try {
        return decoder.decode(data);
    } catch {
        return undefined;
    }
}

function same(a?: FlatEntry, b?: FlatEntry): boolean {
    if (!a || !b) return a === b;
    return a.oid === b.oid && a.mode === b.mode;
}

function isBinary(data: Uint8Array): boolean {
    return data.subarray(0, 8000).includes(0);
}

/** Split after every "\n", keeping each line's terminator and every other byte. */
function lines(text: string): string[] {
    const out: string[] = [];
    let start = 0;
    for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", start)) {
        out.push(text.slice(start, i + 1));
        start = i + 1;
    }
    if (start < text.length) out.push(text.slice(start));
    return out;
}

/**
 * Merge the contents of one file. Returns the merged text, or the text with
 * conflict markers and `clean: false`. With strategy "ours"/"theirs",
 * conflicting hunks are resolved to that side.
 */
export function mergeText(
    base: string,
    ours: string,
    theirs: string,
    strategy: MergeStrategy,
    labels: { ours: string; theirs: string }
): { clean: boolean; text: string } {
    const result = diff3Merge(lines(ours), lines(base), lines(theirs));
    let text = "";
    let clean = true;
    const withNewline = (s: string) =>
        s === "" || s.endsWith("\n") ? s : s + "\n";
    for (const item of result) {
        if (item.ok) {
            text += item.ok.join("");
        } else if (item.conflict) {
            const a = item.conflict.a.join("");
            const b = item.conflict.b.join("");
            if (strategy === "ours") text += a;
            else if (strategy === "theirs") text += b;
            else {
                clean = false;
                text +=
                    `<<<<<<< ${labels.ours}\n` +
                    withNewline(a) +
                    "=======\n" +
                    withNewline(b) +
                    `>>>>>>> ${labels.theirs}\n`;
            }
        }
    }
    return { clean, text };
}

/** Merge the trees of `ours` and `theirs` against their common `base`. */
export async function mergeTrees(
    repo: Repository,
    base: string | undefined,
    ours: string,
    theirs: string,
    opts: { strategy: MergeStrategy; labels: { ours: string; theirs: string } }
): Promise<TreeMergeResult> {
    const b = await repo.flatten(base);
    const o = await repo.flatten(ours);
    const t = await repo.flatten(theirs);
    const merged = new Map<string, FlatEntry>();
    const conflicts: Conflict[] = [];
    const paths = new Set([...b.keys(), ...o.keys(), ...t.keys()]);

    for (const path of [...paths].sort()) {
        const be = b.get(path);
        const oe = o.get(path);
        const te = t.get(path);
        let result: FlatEntry | undefined;
        if (same(oe, te)) result = oe;
        else if (same(be, oe)) result = te;
        else if (same(be, te)) result = oe;
        else if (oe && te) {
            // Changed (or added) differently on both sides.
            const [bd, od, td] = await Promise.all([
                be ? repo.objects.readTyped(be.oid, "blob") : new Uint8Array(),
                repo.objects.readTyped(oe.oid, "blob"),
                repo.objects.readTyped(te.oid, "blob"),
            ]);
            const mode = oe.mode === be?.mode ? te.mode : oe.mode;
            const texts = [bd, od, td].map((d) =>
                isBinary(d) ? undefined : decodeText(d)
            );
            if (texts.some((t) => t === undefined)) {
                if (opts.strategy === "ours") result = oe;
                else if (opts.strategy === "theirs") result = te;
                else {
                    conflicts.push({
                        path,
                        base: be,
                        ours: oe,
                        theirs: te,
                        worktree: od,
                    });
                    merged.set(path, oe);
                    continue;
                }
            } else {
                const m = mergeText(
                    texts[0]!,
                    texts[1]!,
                    texts[2]!,
                    opts.strategy,
                    opts.labels
                );
                const data = encoder.encode(m.text);
                if (m.clean) {
                    result = {
                        oid: await repo.objects.write("blob", data),
                        mode,
                    };
                } else {
                    conflicts.push({
                        path,
                        base: be,
                        ours: oe,
                        theirs: te,
                        worktree: data,
                    });
                    merged.set(path, oe);
                    continue;
                }
            }
        } else {
            // Deleted on one side, changed on the other: keep the change in
            // the working tree, but let the user decide.
            const survivor = (oe ?? te)!;
            conflicts.push({
                path,
                base: be,
                ours: oe,
                theirs: te,
                worktree: await repo.objects.readTyped(survivor.oid, "blob"),
            });
            merged.set(path, survivor);
            continue;
        }
        if (result) merged.set(path, result);
    }

    // A file on one side where the other has a folder: git would rename one
    // of them, which this implementation does not do. Refuse before anything
    // is written rather than drop either side.
    const dirs = new Set<string>();
    for (const p of merged.keys()) {
        const parts = p.split("/");
        for (let i = 1; i < parts.length; i++)
            dirs.add(parts.slice(0, i).join("/"));
    }
    const clashes = [...merged.keys()].filter((p) => dirs.has(p));
    if (clashes.length > 0) {
        throw new UnsupportedError(
            `Cannot merge: ${clashes.join(", ")} is a file on one side and a folder on the other. Resolve this on a device with Git.`
        );
    }
    return { merged, conflicts };
}

/** Write the trees for a flat path → entry map and return the root tree id. */
export async function writeFlatTree(
    repo: Repository,
    flat: Map<string, FlatEntry>
): Promise<string> {
    interface Dir {
        files: TreeEntry[];
        dirs: Map<string, Dir>;
    }
    const root: Dir = { files: [], dirs: new Map() };
    for (const [path, e] of flat) {
        const parts = path.split("/");
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
            mode: e.mode,
            name: parts[parts.length - 1]!,
            oid: e.oid,
        });
    }
    const write = async (dir: Dir): Promise<string> => {
        const entries = dir.files.filter((f) => !dir.dirs.has(f.name));
        for (const [name, sub] of dir.dirs) {
            entries.push({ mode: MODE_TREE, name, oid: await write(sub) });
        }
        return repo.objects.write("tree", serializeTree(entries));
    };
    return write(root);
}
