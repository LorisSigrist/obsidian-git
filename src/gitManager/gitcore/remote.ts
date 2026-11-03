// Fetching and pushing over smart HTTP.

import { PushRejectedError } from "./errors";
import { isAncestor } from "./history";
import { MODE_GITLINK, MODE_TREE } from "./model";
import type { Repository } from "./repository";
import {
    concat,
    demuxSideband,
    discoverRefs,
    FLUSH,
    GitHttpSession,
    pktLine,
    PktReader,
    type AuthCallbacks,
    type HttpClient,
    type RemoteRefs,
} from "./transport";
import { PackIndexer, PackWriter } from "./wasm";

const ZERO = "0".repeat(40);
const AGENT = "agent=git/obsidian-git";

export interface RemoteOptions {
    url: string;
    http: HttpClient;
    auth?: AuthCallbacks;
    onProgress?: (message: string) => void;
}

interface Refspec {
    force: boolean;
    src: string;
    dst: string;
}

export function parseRefspec(spec: string): Refspec {
    const force = spec.startsWith("+");
    const [src, dst] = (force ? spec.slice(1) : spec).split(":");
    return { force, src: src ?? "", dst: dst ?? "" };
}

/** The local name for remote ref `name` under `spec`, or undefined. */
function mapRef(spec: Refspec, name: string): string | undefined {
    const star = spec.src.indexOf("*");
    if (star < 0) return name === spec.src ? spec.dst : undefined;
    const prefix = spec.src.slice(0, star);
    const suffix = spec.src.slice(star + 1);
    if (
        !name.startsWith(prefix) ||
        !name.endsWith(suffix) ||
        name.length < prefix.length + suffix.length
    )
        return undefined;
    const middle = name.slice(prefix.length, name.length - suffix.length);
    return spec.dst.replace("*", middle);
}

async function readShallow(repo: Repository): Promise<Set<string>> {
    const text = await repo.fs.readText(`${repo.gitdir}/shallow`);
    return new Set(
        (text ?? "").split("\n").filter((l) => /^[0-9a-f]{40}$/.test(l))
    );
}

async function writeShallow(repo: Repository, oids: Set<string>) {
    const path = `${repo.gitdir}/shallow`;
    if (oids.size === 0) await repo.fs.remove(path);
    else await repo.fs.write(path, [...oids].sort().join("\n") + "\n");
}

/**
 * Commits to tell the server we have: every remote-tracking and tag tip
 * first (the likely common commits, however many local commits are
 * unpushed), then other recent commits, newest first, up to `limit`.
 */
async function haves(repo: Repository, limit = 256): Promise<string[]> {
    const isCommit = async (oid: string | null) =>
        !!oid &&
        (await repo.objects.has(oid)) &&
        (await repo.objects.read(oid)).type === "commit";
    const out: string[] = [];
    const seen = new Set<string>();
    for (const prefix of ["refs/remotes/", "refs/tags/"]) {
        for (const name of await repo.refs.list(prefix)) {
            const oid = await repo.refs.resolveFull(prefix + name);
            if (oid && !seen.has(oid) && (await isCommit(oid))) {
                seen.add(oid);
                out.push(oid);
            }
        }
    }
    const queue: { oid: string; time: number }[] = [];
    const push = async (oid: string | null) => {
        if (!oid || seen.has(oid) || !(await isCommit(oid))) return;
        seen.add(oid);
        const c = await repo.objects.readCommit(oid);
        queue.push({ oid, time: c.committer.timestamp });
    };
    for (const name of await repo.refs.list("refs/heads/")) {
        await push(await repo.refs.resolveFull(`refs/heads/${name}`));
    }
    for (const oid of [...out]) {
        for (const p of (await repo.objects.readCommit(oid)).parents)
            await push(p);
    }
    while (queue.length > 0 && out.length < limit) {
        let best = 0;
        for (let i = 1; i < queue.length; i++) {
            if (queue[i]!.time > queue[best]!.time) best = i;
        }
        const { oid } = queue.splice(best, 1)[0]!;
        out.push(oid);
        for (const p of (await repo.objects.readCommit(oid)).parents)
            await push(p);
    }
    return out;
}

/**
 * Store a pack: append it to a temporary file while indexing it in WASM,
 * resolve deltas by reading back ranges, then publish the pack and its index.
 * Returns the number of objects. A `promisor` pack (from a partial fetch) is
 * marked as such, so Git knows the objects it leaves out are on the remote.
 */
export async function storePack(
    repo: Repository,
    chunks: Uint8Array[],
    promisor = false
): Promise<number> {
    const dir = repo.objects.packDir;
    const tmp = `${dir}/tmp_pack_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const ix = new PackIndexer();
    try {
        const pending: Uint8Array[] = [];
        let pendingSize = 0;
        let size = 0;
        const flush = async () => {
            if (pendingSize === 0) return;
            await repo.fs.append(tmp, concat(pending));
            pending.length = 0;
            pendingSize = 0;
        };
        for (const chunk of chunks) {
            ix.push(chunk);
            pending.push(chunk);
            pendingSize += chunk.length;
            size += chunk.length;
            if (pendingSize >= 1 << 20) await flush();
        }
        await flush();
        ix.finish();
        const count = ix.object_count();
        if (count === 0) {
            await repo.fs.remove(tmp);
            return 0;
        }
        for (let req = ix.next_read(); req; req = ix.next_read()) {
            ix.provide(await repo.fs.readRange(tmp, size, req[0]!, req[1]!));
        }
        const name = `pack-${ix.checksum_hex()}`;
        const idx = ix.build_idx();
        if (promisor) await repo.fs.write(`${dir}/${name}.promisor`, "");
        if (await repo.fs.exists(`${dir}/${name}.pack`)) {
            await repo.fs.remove(tmp);
        } else {
            // The pack goes first: an index without its pack would be broken.
            await repo.fs.rename(tmp, `${dir}/${name}.pack`);
        }
        // Written aside and renamed, so a crash cannot leave a truncated index.
        await repo.fs.write(`${tmp}.idx`, idx);
        await repo.fs.remove(`${dir}/${name}.idx`);
        await repo.fs.rename(`${tmp}.idx`, `${dir}/${name}.idx`);
        repo.objects.invalidatePacks();
        return count;
    } catch (e) {
        await repo.fs.remove(tmp).catch(() => undefined);
        await repo.fs.remove(`${tmp}.idx`).catch(() => undefined);
        throw e;
    } finally {
        ix.free();
    }
}

export interface FetchResult {
    remoteRefs: RemoteRefs;
    /** Local refs that changed: name → [old (or undefined), new]. */
    updated: Map<string, [string | undefined, string]>;
    /** Whether the server applied `filter` (it may not support filters). */
    filtered: boolean;
}

/**
 * The ACK/NAK lines that end the negotiation. Without multi_ack there is a
 * NAK or an ACK, but after "done" the server may also repeat ACKs for
 * further common commits, so every ACK before the pack is consumed.
 */
function readAcks(reader: PktReader): void {
    const first = reader.nextLine();
    if (first === null || !(first === "NAK" || first.startsWith("ACK "))) {
        throw new Error(`Unexpected negotiation response: ${first}`);
    }
    while (!reader.done && /^[0-9a-f]{4}(ACK |NAK)/.test(reader.peekText(8))) {
        reader.next();
    }
}

/** The pack in an upload-pack response, after the negotiation lines. */
function packChunks(
    reader: PktReader,
    sideband: boolean,
    onProgress?: (message: string) => void
): Uint8Array[] {
    const chunks: Uint8Array[] = [];
    if (sideband) demuxSideband(reader, (c) => chunks.push(c), onProgress);
    else chunks.push(reader.rest());
    return chunks;
}

/**
 * `git fetch <remote>`: download what the refspecs need and update the
 * remote-tracking refs. With `depth`, fetch a shallow history; with
 * `filter` (e.g. "blob:none"), a partial one, if the server supports it.
 */
export async function fetchRemote(
    repo: Repository,
    opts: RemoteOptions & {
        remote: string;
        refspecs: string[];
        depth?: number;
        filter?: string;
    }
): Promise<FetchResult> {
    const session = new GitHttpSession(opts.http, opts.url, opts.auth);
    const remoteRefs = await discoverRefs(session, "git-upload-pack");
    const specs = opts.refspecs.map(parseRefspec);

    const targets: { local: string; oid: string; force: boolean }[] = [];
    for (const [name, oid] of remoteRefs.refs) {
        if (!name.startsWith("refs/") || name.endsWith("^{}")) continue;
        for (const spec of specs) {
            const local = mapRef(spec, name);
            if (local) targets.push({ local, oid, force: spec.force });
        }
    }

    const wants = new Set<string>();
    for (const t of targets) {
        if (!(await repo.objects.has(t.oid))) wants.add(t.oid);
    }

    // Only partial when the missing contents can be fetched by id later.
    const filtered =
        opts.filter !== undefined &&
        remoteRefs.capabilities.has("filter") &&
        canFetchById(remoteRefs.capabilities);
    if (wants.size > 0) {
        const caps = remoteRefs.capabilities;
        const shallow = await readShallow(repo);
        const useShallow = opts.depth !== undefined || shallow.size > 0;
        if (useShallow && !caps.has("shallow")) {
            throw new Error("The remote does not support shallow fetches.");
        }
        const myCaps = ["ofs-delta", AGENT];
        if (caps.has("side-band-64k")) myCaps.push("side-band-64k");
        if (caps.has("no-progress") && !opts.onProgress)
            myCaps.push("no-progress");
        if (useShallow) myCaps.push("shallow");
        if (filtered) myCaps.push("filter");

        const lines: Uint8Array[] = [];
        [...wants].forEach((oid, i) =>
            lines.push(
                pktLine(`want ${oid}${i === 0 ? " " + myCaps.join(" ") : ""}\n`)
            )
        );
        for (const oid of shallow) lines.push(pktLine(`shallow ${oid}\n`));
        if (opts.depth !== undefined) {
            lines.push(pktLine(`deepen ${opts.depth}\n`));
        }
        if (filtered) lines.push(pktLine(`filter ${opts.filter}\n`));
        lines.push(FLUSH);
        for (const oid of await haves(repo))
            lines.push(pktLine(`have ${oid}\n`));
        lines.push(pktLine("done\n"));

        const res = await session.request({
            path: "/git-upload-pack",
            method: "POST",
            headers: {
                "Content-Type": "application/x-git-upload-pack-request",
                Accept: "application/x-git-upload-pack-result",
            },
            body: concat(lines),
        });
        const reader = new PktReader(res.body);
        if (opts.depth !== undefined) {
            // shallow-update section, ended by a flush.
            for (
                let line = reader.nextLine();
                line !== null;
                line = reader.nextLine()
            ) {
                const [kind, oid] = line.split(" ");
                if (kind === "shallow" && oid) shallow.add(oid);
                else if (kind === "unshallow" && oid) shallow.delete(oid);
            }
        }
        readAcks(reader);
        await storePack(
            repo,
            packChunks(
                reader,
                myCaps.includes("side-band-64k"),
                opts.onProgress
            ),
            filtered
        );
        if (useShallow) await writeShallow(repo, shallow);
    }

    const updated = new Map<string, [string | undefined, string]>();
    const fetchHead: string[] = [];
    for (const t of targets) {
        const old = (await repo.refs.resolveFull(t.local)) ?? undefined;
        fetchHead.push(`${t.oid}\t\t${t.local}`);
        if (old === t.oid) continue;
        if (
            old &&
            !t.force &&
            !(await isAncestor(repo, old, t.oid).catch(() => false))
        )
            continue; // git refuses non-fast-forward updates without "+"
        await repo.refs.write(t.local, t.oid);
        updated.set(t.local, [old, t.oid]);
    }
    if (fetchHead.length > 0) {
        await repo.fs.write(
            `${repo.gitdir}/FETCH_HEAD`,
            fetchHead.join("\n") + "\n"
        );
    }
    // Record the remote's default branch, as `git clone` does.
    const remoteHead = `refs/remotes/${opts.remote}/HEAD`;
    if (
        remoteRefs.headTarget &&
        (await repo.refs.readRaw(remoteHead)) === null
    ) {
        const local = specs
            .map((s) => mapRef(s, remoteRefs.headTarget!))
            .find((x) => x !== undefined);
        if (local && (await repo.refs.readRaw(local)) !== null) {
            await repo.refs.writeSymbolic(remoteHead, local);
        }
    }
    return { remoteRefs, updated, filtered };
}

export interface ObjectFetchProgress {
    /** Objects downloaded so far, of `total`. */
    done: number;
    total: number;
    /** Pack bytes downloaded so far. */
    bytes: number;
}

function canFetchById(caps: Set<string>): boolean {
    return (
        caps.has("allow-reachable-sha1-in-want") ||
        caps.has("allow-any-sha1-in-want")
    );
}

/** Contents that are usually small; anything else may be large. */
const SMALL_FILE =
    /\.(md|txt|json|canvas|css|js|ts|csv|tsv|ya?ml|html?|xml|tex|bib|svg|ics|vcf|base|gitignore|gitattributes)$/i;

/** Contents that are often huge: fetched one at a time. */
const HUGE_FILE =
    /\.(mp4|m4v|mov|avi|mkv|webm|wmv|zip|7z|rar|tar|tgz|gz|dmg|iso)$/i;

/** Aimed-for size of one download, which is held in memory whole. */
const BATCH_BYTES = 24 << 20;

/**
 * Download objects by id (in a partial clone: file contents), in batches
 * small enough to hold in memory. Objects already here are skipped, so an
 * interrupted download resumes where it stopped.
 *
 * The protocol cannot tell sizes in advance, so the batch size adapts to the
 * sizes seen so far, separately for usually-small text files, possibly-large
 * ones (PDFs, images, ...) and often-huge ones (videos, archives).
 */
export async function fetchObjects(
    repo: Repository,
    opts: RemoteOptions & {
        objects: { oid: string; path: string }[];
        onBatch?: (progress: ObjectFetchProgress) => void;
    }
): Promise<void> {
    const missing: { oid: string; path: string }[] = [];
    const seen = new Set<string>();
    // One look at the pack directory, not one per missing object.
    repo.objects.invalidatePacks();
    for (const o of opts.objects) {
        if (seen.has(o.oid)) continue;
        seen.add(o.oid);
        if (!(await repo.objects.has(o.oid, false))) missing.push(o);
    }
    if (missing.length === 0) return;
    const session = new GitHttpSession(opts.http, opts.url, opts.auth);
    const { capabilities: caps } = await discoverRefs(
        session,
        "git-upload-pack"
    );
    if (!canFetchById(caps)) {
        throw new Error(
            "The remote does not allow fetching file contents on demand, which this partial clone needs."
        );
    }
    const myCaps = ["ofs-delta", AGENT];
    if (caps.has("side-band-64k")) myCaps.push("side-band-64k");
    if (caps.has("no-progress")) myCaps.push("no-progress");

    const groups = [
        {
            items: missing.filter((o) => SMALL_FILE.test(o.path)),
            avg: 16 << 10,
            max: 1000,
        },
        {
            items: missing.filter(
                (o) => !SMALL_FILE.test(o.path) && !HUGE_FILE.test(o.path)
            ),
            avg: 4 << 20,
            max: 8,
        },
        {
            items: missing.filter((o) => HUGE_FILE.test(o.path)),
            avg: BATCH_BYTES,
            max: 1,
        },
    ];
    const progress = { done: 0, total: missing.length, bytes: 0 };
    opts.onBatch?.({ ...progress });
    for (const group of groups) {
        let fetched = 0;
        let fetchedBytes = 0;
        let lastAvg = 0;
        for (let i = 0; i < group.items.length;) {
            // The larger of the overall and the latest average, so a run of
            // big files shrinks the next batch at once.
            const avg = Math.max(
                fetched > 0 ? fetchedBytes / fetched : group.avg,
                lastAvg
            );
            const n = Math.max(
                1,
                Math.min(group.max, Math.floor(BATCH_BYTES / avg))
            );
            const batch = group.items.slice(i, i + n);
            i += batch.length;
            const lines = batch.map((o, j) =>
                pktLine(
                    `want ${o.oid}${j === 0 ? " " + myCaps.join(" ") : ""}\n`
                )
            );
            lines.push(FLUSH, pktLine("done\n"));
            const res = await session.request({
                path: "/git-upload-pack",
                method: "POST",
                headers: {
                    "Content-Type": "application/x-git-upload-pack-request",
                    Accept: "application/x-git-upload-pack-result",
                },
                body: concat(lines),
            });
            const reader = new PktReader(res.body);
            readAcks(reader);
            await storePack(
                repo,
                packChunks(reader, myCaps.includes("side-band-64k")),
                true
            );
            fetched += batch.length;
            fetchedBytes += res.body.length;
            lastAvg = res.body.length / batch.length;
            progress.done += batch.length;
            progress.bytes += res.body.length;
            opts.onBatch?.({ ...progress });
        }
    }
    for (const o of missing) {
        if (!(await repo.objects.has(o.oid))) {
            throw new Error(`The remote did not send ${o.path} (${o.oid}).`);
        }
    }
}

/** Objects reachable from `oid`'s tree that are not in `have`, added to `out`. */
async function collectTree(
    repo: Repository,
    tree: string,
    have: Set<string>,
    out: Set<string>
): Promise<void> {
    if (have.has(tree) || out.has(tree)) return;
    out.add(tree);
    for (const e of await repo.objects.readTree(tree)) {
        if (e.mode === MODE_GITLINK) continue;
        if (e.mode === MODE_TREE) await collectTree(repo, e.oid, have, out);
        else if (!have.has(e.oid)) out.add(e.oid);
    }
}

/** Every tree and blob reachable from a tree. */
async function allTreeObjects(
    repo: Repository,
    tree: string,
    out: Set<string>
): Promise<void> {
    if (out.has(tree)) return;
    out.add(tree);
    for (const e of await repo.objects.readTree(tree)) {
        if (e.mode === MODE_GITLINK) continue;
        if (e.mode === MODE_TREE) await allTreeObjects(repo, e.oid, out);
        else out.add(e.oid);
    }
}

/**
 * The objects a remote that has `remoteTips` needs to get to `tip`.
 *
 * Commits are found like `git rev-list tip --not remoteTips`: a walk in
 * commit-date order from both sides that stops once only remote-side commits
 * are left, so it does not visit the remote's whole history. Clock skew can
 * only make it send extra objects, never too few.
 */
async function objectsToSend(
    repo: Repository,
    tip: string,
    remoteTips: string[]
): Promise<string[]> {
    /** oid → true when the remote has it ("uninteresting"). */
    const remoteHas = new Map<string, boolean>();
    const queue: { oid: string; time: number }[] = [];
    const add = async (oid: string, remote: boolean) => {
        const known = remoteHas.get(oid);
        if (known === true || (known === false && !remote)) return;
        if (!(await repo.objects.has(oid))) return;
        if ((await repo.objects.read(oid)).type !== "commit") return;
        remoteHas.set(oid, remote);
        const time = (await repo.objects.readCommit(oid)).committer.timestamp;
        // Re-queued when it turns out the remote has it, to pass that on.
        queue.push({ oid, time });
    };
    await add(tip, false);
    for (const t of remoteTips) if (t !== ZERO) await add(t, true);
    while (queue.some((q) => remoteHas.get(q.oid) === false)) {
        let best = 0;
        for (let i = 1; i < queue.length; i++) {
            if (queue[i]!.time > queue[best]!.time) best = i;
        }
        const { oid } = queue.splice(best, 1)[0]!;
        const remote = remoteHas.get(oid)!;
        for (const p of (await repo.objects.readCommit(oid)).parents) {
            await add(p, remote);
        }
    }
    const commits = [...remoteHas]
        .filter(([, remote]) => !remote)
        .map(([oid]) => oid);
    // Trees and blobs of the remote-side commits the new ones build on.
    const have = new Set<string>();
    for (const c of commits) {
        for (const p of (await repo.objects.readCommit(c)).parents) {
            if (remoteHas.get(p) === true) {
                await allTreeObjects(
                    repo,
                    (await repo.objects.readCommit(p)).tree,
                    have
                );
            }
        }
    }
    const out = new Set<string>(commits);
    for (const c of commits) {
        await collectTree(
            repo,
            (await repo.objects.readCommit(c)).tree,
            have,
            out
        );
    }
    if (repo.objects.onMissing) {
        // In a partial clone, contents never downloaded came from the
        // remote, so it has them; new local content is always stored here.
        for (const oid of out) {
            if (!(await repo.objects.has(oid))) out.delete(oid);
        }
    }
    return [...out];
}

export interface PushOutcome {
    status: "up-to-date" | "pushed";
    /** The commit the remote ref now points at. */
    oid: string;
}

/**
 * Push local ref `localRef` to `remoteRef` on the remote (fast-forward only
 * unless `force`). Throws PushRejectedError when the remote or the
 * fast-forward check refuses.
 */
export async function pushRef(
    repo: Repository,
    opts: RemoteOptions & {
        localRef: string;
        remoteRef: string;
        force?: boolean;
    }
): Promise<PushOutcome> {
    const session = new GitHttpSession(opts.http, opts.url, opts.auth);
    const remoteRefs = await discoverRefs(session, "git-receive-pack");
    const next = await repo.refs.resolveFull(opts.localRef);
    if (!next)
        throw new Error(`Nothing to push: ${opts.localRef} does not exist`);
    const old = remoteRefs.refs.get(opts.remoteRef) ?? ZERO;
    if (old === next) return { status: "up-to-date", oid: next };
    if (old !== ZERO && !opts.force) {
        if (!(await repo.objects.has(old))) {
            throw new PushRejectedError(
                "fetch first: the remote contains work that you do not have locally"
            );
        }
        if (!(await isAncestor(repo, old, next))) {
            throw new PushRejectedError("not-fast-forward");
        }
    }

    const oids = await objectsToSend(repo, next, [...remoteRefs.refs.values()]);
    const writer = new PackWriter(oids.length);
    const parts: Uint8Array[] = [writer.header()];
    try {
        for (const oid of oids) {
            const obj = await repo.objects.read(oid);
            parts.push(writer.entry(obj.type, obj.data));
        }
        parts.push(writer.finish());
    } finally {
        writer.free();
    }

    const caps = ["report-status", AGENT];
    const sideband = remoteRefs.capabilities.has("side-band-64k");
    if (sideband) caps.push("side-band-64k");
    const body = concat([
        pktLine(`${old} ${next} ${opts.remoteRef}\0${caps.join(" ")}\n`),
        FLUSH,
        ...parts,
    ]);
    const res = await session.request({
        path: "/git-receive-pack",
        method: "POST",
        headers: {
            "Content-Type": "application/x-git-receive-pack-request",
            Accept: "application/x-git-receive-pack-result",
        },
        body,
    });

    let report: Uint8Array;
    if (sideband) {
        const data: Uint8Array[] = [];
        demuxSideband(
            new PktReader(res.body),
            (c) => data.push(c),
            opts.onProgress
        );
        report = concat(data);
    } else {
        report = res.body;
    }
    const reader = new PktReader(report);
    const unpack = reader.nextLine();
    if (unpack !== "unpack ok") {
        throw new Error(`The remote could not unpack the push: ${unpack}`);
    }
    for (
        let line = reader.nextLine();
        line !== null;
        line = reader.nextLine()
    ) {
        if (line.startsWith("ng ")) {
            const reason = line.slice(3 + opts.remoteRef.length + 1);
            throw new PushRejectedError(
                /non-fast-forward|fetch first/.test(reason)
                    ? "not-fast-forward"
                    : reason
            );
        }
    }
    return { status: "pushed", oid: next };
}
