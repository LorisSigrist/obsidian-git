// Commit graph queries: ancestry and merge bases.

import type { Repository } from "./repository";

/** Ancestors of `oid` including itself; parents missing in a shallow clone are skipped. */
async function ancestors(repo: Repository, oid: string): Promise<Set<string>> {
    const seen = new Set<string>([oid]);
    const stack = [oid];
    while (stack.length > 0) {
        const commit = await repo.objects.readCommit(stack.pop()!);
        for (const p of commit.parents) {
            if (seen.has(p) || !(await repo.objects.has(p))) continue;
            seen.add(p);
            stack.push(p);
        }
    }
    return seen;
}

/** Whether `ancestor` is reachable from `descendant` (or equal to it). */
export async function isAncestor(
    repo: Repository,
    ancestor: string,
    descendant: string
): Promise<boolean> {
    if (ancestor === descendant) return true;
    const seen = new Set<string>([descendant]);
    const stack = [descendant];
    while (stack.length > 0) {
        const commit = await repo.objects.readCommit(stack.pop()!);
        for (const p of commit.parents) {
            if (p === ancestor) return true;
            if (seen.has(p) || !(await repo.objects.has(p))) continue;
            seen.add(p);
            stack.push(p);
        }
    }
    return false;
}

/**
 * The best common ancestors of `a` and `b` (`git merge-base --all`): common
 * ancestors that are not themselves ancestors of another common ancestor.
 */
export async function mergeBases(
    repo: Repository,
    a: string,
    b: string
): Promise<string[]> {
    const fromA = await ancestors(repo, a);
    const common: string[] = [];
    const seen = new Set<string>([b]);
    const stack = [b];
    while (stack.length > 0) {
        const oid = stack.pop()!;
        if (fromA.has(oid)) {
            common.push(oid);
            continue; // its ancestors are common too, but never "best"
        }
        for (const p of (await repo.objects.readCommit(oid)).parents) {
            if (seen.has(p) || !(await repo.objects.has(p))) continue;
            seen.add(p);
            stack.push(p);
        }
    }
    const best: string[] = [];
    for (const c of common) {
        let dominated = false;
        for (const other of common) {
            if (other !== c && (await isAncestor(repo, c, other))) {
                dominated = true;
                break;
            }
        }
        if (!dominated) best.push(c);
    }
    return best;
}
