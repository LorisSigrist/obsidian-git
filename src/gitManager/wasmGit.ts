import { createPatch } from "diff";
import { normalizePath, Notice, requestUrl } from "obsidian";
import type ObsidianGit from "../main";
import type {
    BranchInfo,
    DiffFile,
    FileStatusResult,
    LogEntry,
    PullResult,
    PushResult,
    Status,
    UnstagedFile,
    WalkDifference,
} from "../types";
import {
    createAutoCommitPathSelector,
    type AutoCommitGlobSelection,
    type AutoCommitSelectedFiles,
} from "../autoCommitGlobs";
import { GitConflictError, GitOperation } from "../types";
import { GitManager } from "./gitManager";
import {
    MergeConflictError,
    NotFoundError,
    UnmergedPathsError,
} from "./gitcore/errors";
import { GitIndex, type IndexEntry } from "./gitcore/gitIndex";
import { MODE_GITLINK, MODE_TREE, type Person } from "./gitcore/model";
import type { RangeReader } from "./gitcore/repoFs";
import {
    Repository,
    type FlatEntry,
    type StatusRow,
} from "./gitcore/repository";
import { CheckoutConflictError, checkoutTree } from "./gitcore/checkout";
import { mergeTrees, writeFlatTree, type Conflict } from "./gitcore/merge";
import { fetchObjects, fetchRemote, pushRef } from "./gitcore/remote";
import type { AuthCallbacks, HttpClient } from "./gitcore/transport";
import { GeneralModal } from "../ui/modals/generalModal";
import { splitRemoteBranch } from "../utils";
import { isAncestor, mergeBases } from "./gitcore/history";
import {
    cleanMessage,
    person,
    resetPaths,
    restoreFromIndex,
    stagePaths,
    unstagedChanges,
    updateHead,
    writeCommit,
    writeTree,
} from "./gitcore/worktree";

/**
 * Present in the git directory while a clone is still downloading. It holds
 * the remote URL, so running the clone again resumes instead of starting over.
 */
const CLONE_MARKER = "obsidian-git-clone";

function formatBytes(n: number): string {
    if (n < 1 << 20) return `${Math.round(n / 1024)} KB`;
    if (n < 1 << 30) return `${Math.round(n / (1 << 20))} MB`;
    return `${(n / (1 << 30)).toFixed(2)} GB`;
}

const decoder = new TextDecoder();

/** ISO 8601 in the commit's own timezone, as `git log --date=iso-strict` prints it. */
function isoDate(p: Person): string {
    const sign = p.timezone.startsWith("-") ? -1 : 1;
    const offsetMin =
        sign *
        (Number(p.timezone.slice(1, 3)) * 60 + Number(p.timezone.slice(3, 5)));
    const local = new Date((p.timestamp + offsetMin * 60) * 1000);
    const pad = (n: number) => String(n).padStart(2, "0");
    return (
        `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
        `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
        (offsetMin === 0
            ? "Z"
            : `${p.timezone.slice(0, 3)}:${p.timezone.slice(3, 5)}`)
    );
}

function toArrayBuffer(u: Uint8Array): ArrayBuffer {
    return u.byteOffset === 0 && u.byteLength === u.buffer.byteLength
        ? (u.buffer as ArrayBuffer)
        : u.slice().buffer;
}

// If `buffer` starts with the gzip magic bytes, inflate it. A smart-HTTP body
// never starts with those bytes (it begins with a pkt-line length or "PACK"),
// and some platforms inflate transparently while leaving the header in place,
// so this is keyed on the content rather than Content-Encoding.
async function inflateIfGzipped(buffer: ArrayBuffer): Promise<ArrayBuffer> {
    const bytes = new Uint8Array(buffer);
    if (bytes.length < 2 || bytes[0] !== 0x1f || bytes[1] !== 0x8b) {
        return buffer;
    }
    try {
        const stream = new Blob([buffer])
            .stream()
            .pipeThrough(new DecompressionStream("gzip"));
        return await new Response(stream).arrayBuffer();
    } catch {
        return buffer;
    }
}

/**
 * A local branch name for `remote/branch` that does not collide with existing
 * ones: `branch`, then `branch-remote`, then `branch-remote-1`, ... (as the
 * native backend chooses).
 */
function availableBranchName(
    branch: string,
    remote: string,
    existing: string[]
): string {
    if (!existing.includes(branch)) return branch;
    const base = `${branch}-${remote}`;
    let candidate = base;
    for (let n = 1; existing.includes(candidate); n++) {
        candidate = `${base}-${n}`;
    }
    return candidate;
}

/** Reject names `git check-ref-format --branch` would refuse. */
function assertBranchName(name: string): void {
    const invalid =
        name === "" ||
        name === "@" ||
        name === "HEAD" ||
        name.startsWith("-") ||
        name.startsWith("/") ||
        name.endsWith("/") ||
        name.endsWith(".") ||
        name.split("/").some((part) => part.endsWith(".lock")) ||
        name.includes("..") ||
        name.includes("//") ||
        name.includes("@{") ||
        // eslint-disable-next-line no-control-regex
        /[\x00-\x20\x7f~^:?*[\\]/.test(name) ||
        name.split("/").some((part) => part.startsWith("."));
    if (invalid) throw new Error(`'${name}' is not a valid branch name.`);
}

/**
 * The mobile Git backend: a git implementation on Obsidian's file API, with
 * packfile handling, compression and hashing in WASM.
 */
export class WasmGit extends GitManager {
    private static readonly MERGE_HEAD = "MERGE_HEAD";
    private static readonly MERGE_MESSAGE = "MERGE_MSG";
    private static readonly MERGE_MODE = "MERGE_MODE";
    private static readonly ORIGINAL_HEAD = "ORIG_HEAD";
    // Mapping from status matrix rows to git status codes based off git status --short
    private readonly statusMapping: Readonly<Record<string, string>> = {
        "000": "  ",
        "003": "AD",
        "020": "??",
        "022": "A ",
        "023": "AM",
        "100": "D ",
        "101": " D",
        "103": "MD",
        "110": "DA", // Technically, two files: first one is deleted "D " and second one is untracked "??"
        "111": "  ",
        "113": "MM",
        "120": "DA", // Same as "110"
        "121": " M",
        "122": "M ",
        "123": "MM",
    };
    private readonly noticeLength = 999_999;
    private cachedRepo: { key: string; repo: Promise<Repository> } | undefined;

    /** Random-access reader for packfiles; tests inject one backed by Node's fs. */
    rangeReader: RangeReader | undefined;

    constructor(plugin: ObsidianGit) {
        super(plugin);
    }

    protected getGitDirPath(): string {
        return normalizePath(
            this.getRelativeVaultPath(this.plugin.settings.gitDir || ".git")
        );
    }

    protected repo(): Promise<Repository> {
        const root = this.plugin.settings.basePath
            ? normalizePath(this.plugin.settings.basePath)
            : "";
        const gitdir = this.getGitDirPath();
        const key = `${root}\0${gitdir}`;
        if (this.cachedRepo?.key !== key) {
            this.cachedRepo = {
                key,
                repo: new Repository(this.app.vault, {
                    root,
                    gitdir,
                    rangeReader: this.rangeReader,
                })
                    .ready()
                    .then(async (repo) => {
                        await this.enableLazyFetch(repo);
                        return repo;
                    }),
            };
        }
        return this.cachedRepo.repo;
    }

    /**
     * In a partial clone, download missing file contents on demand from the
     * remote they were left on (`extensions.partialClone`).
     */
    private async enableLazyFetch(repo: Repository): Promise<void> {
        if (!(await repo.exists())) return;
        const remote = (await repo.readConfig()).get("extensions.partialclone");
        repo.objects.onMissing = remote
            ? async (oid) =>
                  fetchObjects(repo, {
                      ...(await this.remoteOptions(remote, undefined, "")),
                      objects: [{ oid, path: oid }],
                  })
            : undefined;
    }

    /**
     * The objects `to` has that `from` does not, for a download before a
     * checkout from one to the other (only missing ones are fetched).
     */
    private async changedObjects(
        repo: Repository,
        from: string | undefined,
        to: string
    ): Promise<{ oid: string; path: string }[]> {
        const flat =
            from === undefined
                ? await repo.flatten(to)
                : await repo.flatten(
                      to,
                      (await repo.diffTrees(from, to)).map((c) => c.path)
                  );
        return [...flat]
            .filter(([, e]) => e.mode !== MODE_GITLINK && e.mode !== MODE_TREE)
            .map(([path, e]) => ({ oid: e.oid, path }));
    }

    /** Download what a checkout to `to` needs, with progress, in a partial clone. */
    private async prefetchForCheckout(
        repo: Repository,
        from: string | undefined,
        to: string,
        notice: Notice | undefined,
        action: string
    ): Promise<void> {
        const remote = (await repo.readConfig()).get("extensions.partialclone");
        if (!remote || !repo.objects.onMissing) return;
        await fetchObjects(repo, {
            ...(await this.remoteOptions(remote, undefined, action)),
            objects: await this.changedObjects(repo, from, to),
            onBatch: ({ done, total, bytes }) =>
                notice?.setMessage(
                    `${action}: downloading files ${done.toLocaleString()} / ${total.toLocaleString()} (${formatBytes(bytes)})`
                ),
        });
    }

    /** Refuse what would build on a clone that has not finished. */
    private async assertCloneFinished(): Promise<void> {
        const repo = await this.repo();
        if (await repo.fs.exists(`${repo.gitdir}/${CLONE_MARKER}`)) {
            throw new Error(
                "A clone into this vault has not finished. Run the clone command again to resume it."
            );
        }
    }

    private withSlowNotice<T>(fn: () => Promise<T>): Promise<T> {
        let notice: Notice | undefined;
        const timeout = window.setTimeout(() => {
            notice = new Notice(
                "This takes longer: Getting status",
                this.noticeLength
            );
        }, 20000);
        return fn().finally(() => {
            window.clearTimeout(timeout);
            notice?.hide();
        });
    }

    async status(opts?: { path?: string }): Promise<Status> {
        return this.withSlowNotice(async () => {
            const repo = await this.repo();
            const filepaths =
                opts?.path != undefined ? [`${opts.path}/`] : undefined;
            const status = (await repo.statusMatrix({ filepaths })).map((row) =>
                this.getFileStatusResult(row)
            );

            let conflicted = await this.getConflictedFiles();
            if (opts?.path != undefined) {
                const path = opts.path.replace(/\/$/, "");
                conflicted = conflicted.filter(
                    (file) => file === path || file.startsWith(`${path}/`)
                );
            }

            const changed: FileStatusResult[] = [];
            const staged: FileStatusResult[] = [];
            const all: FileStatusResult[] = [];
            const conflictedPaths = new Set(conflicted);
            for (const file of status) {
                if (
                    file.workingDir !== " " &&
                    !conflictedPaths.has(file.path)
                ) {
                    changed.push(file);
                }
                if (
                    file.index !== " " &&
                    file.index !== "U" &&
                    !conflictedPaths.has(file.path)
                ) {
                    staged.push(file);
                }
                if (file.index != " " || file.workingDir != " ") {
                    all.push(file);
                }
            }
            return {
                all,
                changed,
                staged,
                conflicted,
                stagedOutsideVault: 0,
                conflictedOutsideVault: 0,
            };
        });
    }

    selectAutoCommitFiles(
        status: Status,
        selection: AutoCommitGlobSelection
    ): Promise<AutoCommitSelectedFiles> {
        const isSelected = createAutoCommitPathSelector(selection);
        return Promise.resolve({
            files: status.changed.filter((file) => isSelected(file.path)),
            selection,
        });
    }

    async getUntrackedPaths(opts: {
        path?: string;
        status?: Status;
    }): Promise<string[]> {
        const untrackedPaths: string[] = [];
        const status = opts.status ?? (await this.status({ path: opts.path }));
        const prefix = opts.path != undefined ? `${opts.path}/` : "";
        for (const file of status.changed) {
            if (
                file.index === "U" &&
                file.workingDir === "U" &&
                file.path.startsWith(prefix)
            ) {
                untrackedPaths.push(file.path);
            }
        }
        return untrackedPaths;
    }

    private getFileStatusResult(row: StatusRow): FileStatusResult {
        const [path, head, workdir, stage] = row;
        const statusKey = `${head}${workdir}${stage}`;
        const status = this.statusMapping[statusKey];
        if (status === undefined) {
            throw new Error(`Unsupported status matrix row: ${statusKey}`);
        }
        return {
            index: status[0] == "?" ? "U" : (status[0] ?? " "),
            workingDir: status[1] == "?" ? "U" : (status[1] ?? " "),
            path,
            vaultPath: this.getRelativeVaultPath(path),
        };
    }

    private async getConflictedFiles(): Promise<string[]> {
        const { index } = await (await this.repo()).readIndex();
        return [...index.conflicts.keys()].sort();
    }

    private getMergeStatePath(filename: string): string {
        return normalizePath(`${this.getGitDirPath()}/${filename}`);
    }

    async isMergeInProgress(): Promise<boolean> {
        return this.app.vault.adapter.exists(
            this.getMergeStatePath(WasmGit.MERGE_HEAD)
        );
    }

    async checkRequirements(): Promise<"valid" | "missing-repo"> {
        const repo = await this.repo();
        // An unfinished clone is not a repository to work with yet; running
        // the clone again resumes it.
        return (await repo.exists()) &&
            !(await repo.fs.exists(`${repo.gitdir}/${CLONE_MARKER}`))
            ? "valid"
            : "missing-repo";
    }

    async resolveRef(ref: string): Promise<string> {
        return (await this.repo()).resolve(ref);
    }

    async branchInfo(): Promise<BranchInfo & { remote: string }> {
        const repo = await this.repo();
        const current = await repo.refs.currentBranch();
        const branches = await repo.refs.list("refs/heads/");
        const config = await repo.readConfig();
        const remote =
            (current && config.get(`branch.${current}.remote`)) || "origin";
        const trackingBranch = current
            ? config.get(`branch.${current}.merge`)?.split("refs/heads")[1]
            : undefined;
        return {
            current,
            tracking: trackingBranch ? remote + trackingBranch : undefined,
            branches,
            remote,
        };
    }

    async getCurrentRemote(): Promise<string> {
        const repo = await this.repo();
        const current = (await repo.refs.currentBranch()) ?? "";
        return (
            (await repo.readConfig()).get(`branch.${current}.remote`) ??
            "origin"
        );
    }

    async getConfig(path: string): Promise<string | undefined> {
        return (await (await this.repo()).readConfig()).get(path);
    }

    async getRemotes(): Promise<string[]> {
        return (await (await this.repo()).readConfig()).subsections("remote");
    }

    async getRemoteUrl(remote: string): Promise<string | undefined> {
        return (await (await this.repo()).readConfig()).get(
            `remote.${remote}.url`
        );
    }

    async getRemoteBranches(remote: string): Promise<string[]> {
        const names = await (
            await this.repo()
        ).refs.list(`refs/remotes/${remote}/`);
        return names.filter((n) => n !== "HEAD").map((n) => `${remote}/${n}`);
    }

    async getFileChangesCount(
        commitHash1: string,
        commitHash2: string
    ): Promise<WalkDifference[]> {
        const repo = await this.repo();
        return repo.diffTrees(
            await repo.commitTree(commitHash1),
            await repo.commitTree(commitHash2)
        );
    }

    async getUnpushedCommits(): Promise<number> {
        const { tracking, current } = await this.branchInfo();
        if (tracking == null || current == null) return 0;
        const localCommit = await this.resolveRef(current);
        const upstreamCommit = await this.resolveRef(tracking);
        return (await this.getFileChangesCount(localCommit, upstreamCommit))
            .length;
    }

    async canPush(): Promise<boolean> {
        const { tracking, current } = await this.branchInfo();
        if (!current) {
            this.plugin.log("During canPush check, no current branch found.");
            return false;
        }
        if (!tracking) return false;
        return (
            (await this.resolveRef(current)) !=
            (await this.resolveRef(tracking))
        );
    }

    async log(
        file?: string,
        relativeToVault = true,
        limit?: number,
        ref?: string
    ): Promise<LogEntry[]> {
        const repo = await this.repo();
        const path = file
            ? this.getRelativeRepoPath(file, relativeToVault)
            : undefined;
        const commits = await repo.log(ref ?? "HEAD", limit, path);
        return Promise.all(
            commits.map(async ({ oid, commit }) => {
                const [subject, ...body] = commit.message
                    .replace(/\s+$/, "")
                    .split("\n\n");
                const parent = commit.parents[0];
                const parentTree =
                    parent && (await repo.objects.has(parent))
                        ? (await repo.objects.readCommit(parent)).tree
                        : undefined;
                const changes = await repo.diffTrees(parentTree, commit.tree);
                return {
                    message: subject ?? "",
                    author: {
                        name: commit.author.name,
                        email: commit.author.email,
                    },
                    body: body.join("\n\n"),
                    date: isoDate(commit.author),
                    diff: {
                        changed: changes.length,
                        files: changes.map<DiffFile>((item) => ({
                            path: item.path,
                            status: item.type,
                            vaultPath: this.getRelativeVaultPath(item.path),
                            hash: oid,
                        })),
                    },
                    hash: oid,
                    refs: [],
                };
            })
        );
    }

    async getStagedFiles(
        dir = "."
    ): Promise<(WalkDifference & { vaultPath: string })[]> {
        const repo = await this.repo();
        const { index } = await repo.readIndex();
        let headTree: string | undefined;
        try {
            headTree = await repo.commitTree("HEAD");
        } catch (e) {
            if (!(e instanceof NotFoundError)) throw e;
        }
        const changes = await repo.diffTreeIndex(
            headTree,
            index,
            dir === "." ? undefined : [dir]
        );
        return changes.map((c) => ({
            ...c,
            vaultPath: this.getRelativeVaultPath(c.path),
        }));
    }

    protected override async getStagedForMessage(): Promise<
        Pick<Status, "staged" | "stagedOutsideVault">
    > {
        if ((await (await this.repo()).headOid()) === undefined) {
            // Without HEAD (first commit) there is no tree to compare with.
            return super.getStagedForMessage();
        }
        const staged = await this.getStagedFiles();
        return {
            staged: staged.map(({ path, vaultPath, type }) => ({
                path,
                vaultPath,
                index: type,
                workingDir: " ",
            })),
            stagedOutsideVault: 0,
        };
    }

    async getDiffString(
        filePath: string,
        stagedChanges = false,
        hash?: string
    ): Promise<string> {
        const repo = await this.repo();
        const vaultPath = this.getRelativeVaultPath(filePath);
        const text = (b: Uint8Array | undefined) =>
            b === undefined ? undefined : decoder.decode(b);

        if (hash) {
            const commitContent = text(await repo.readBlobAt(hash, filePath));
            const commit = await repo.objects.readCommit(
                await repo.resolveCommit(hash)
            );
            const parentOid = commit.parents[0];
            const previousContent = parentOid
                ? text(await repo.readBlobAt(parentOid, filePath))
                : undefined;
            return createPatch(
                vaultPath,
                previousContent ?? "",
                commitContent ?? ""
            );
        }

        const { index } = await repo.readIndex();
        const entry = index.entries.get(filePath);
        const stagedContent = entry
            ? decoder.decode(await repo.objects.readTyped(entry.oid, "blob"))
            : "";

        if (stagedChanges) {
            let headContent: string | undefined;
            if ((await repo.headOid()) !== undefined) {
                headContent = text(await repo.readBlobAt("HEAD", filePath));
            }
            return createPatch(vaultPath, headContent ?? "", stagedContent);
        }
        const workdirContent = (await this.app.vault.adapter.exists(vaultPath))
            ? await this.app.vault.adapter.read(vaultPath)
            : "";
        return createPatch(vaultPath, stagedContent, workdirContent);
    }

    async show(
        commitHash: string,
        file: string,
        relativeToVault = true
    ): Promise<string> {
        const filepath = this.getRelativeRepoPath(file, relativeToVault);
        const blob = await (await this.repo()).readBlobAt(commitHash, filepath);
        if (blob === undefined) {
            throw new NotFoundError(`${filepath} in ${commitHash}`);
        }
        return decoder.decode(blob);
    }

    async getLastCommitTime(): Promise<Date | undefined> {
        const repo = await this.repo();
        const oid = await repo.resolveCommit("HEAD");
        const commit = await repo.objects.readCommit(oid);
        return new Date(commit.committer.timestamp * 1000);
    }

    updateBasePath(_: string): Promise<void> {
        this.cachedRepo = undefined;
        return Promise.resolve();
    }

    updateGitPath(_: string): Promise<void> {
        // This backend has its own git implementation.
        return Promise.resolve();
    }

    // ---- Staging and committing ----

    private indexQueue: Promise<unknown> = Promise.resolve();

    /**
     * Run a read-modify-write of the index. Calls are serialized so concurrent
     * stage/unstage requests cannot overwrite each other's changes.
     */
    private withIndex<T>(
        write: boolean,
        fn: (repo: Repository, index: GitIndex, mtime: number) => Promise<T>
    ): Promise<T> {
        const run = this.indexQueue.then(async () => {
            const repo = await this.repo();
            const { index, mtime } = await repo.readIndex();
            const result = await fn(repo, index, mtime);
            if (write) await repo.writeIndex(index);
            return result;
        });
        this.indexQueue = run.catch(() => undefined);
        return run;
    }

    private async checkAuthorInfo(): Promise<{ name: string; email: string }> {
        const name = await this.getConfig("user.name");
        const email = await this.getConfig("user.email");
        if (!name || !email) {
            throw Error(
                "Git author name and email are not set. Please set both fields in the settings."
            );
        }
        return { name, email };
    }

    async setConfig(
        path: string,
        value: string | number | boolean | undefined
    ): Promise<void> {
        const repo = await this.repo();
        const config = await repo.readConfig();
        config.set(path, value === undefined ? undefined : String(value));
        await repo.writeConfig(config);
    }

    async stage(filepath: string, relativeToVault: boolean): Promise<void> {
        const gitPath = this.getRelativeRepoPath(filepath, relativeToVault);
        await this.withIndex(true, async (repo, index) =>
            stagePaths(repo, index, [gitPath], await repo.ignoreRules())
        );
    }

    async stageAll({
        dir,
        status,
        unstagedFiles,
        selection,
    }: {
        dir?: string;
        status?: Status;
        unstagedFiles?: FileStatusResult[];
        selection?: AutoCommitGlobSelection;
    }): Promise<void> {
        const statusFiles = unstagedFiles ?? status?.changed;
        const files = statusFiles
            ? statusFiles.map((file) => file.path)
            : (await this.getUnstagedFiles(dir ?? ".")).map(({ path }) => path);
        const isSelected = selection
            ? createAutoCommitPathSelector(selection)
            : () => true;
        const selected = files.filter((path) => isSelected(path));
        await this.withIndex(true, async (repo, index) => {
            // `status.changed` leaves conflicted paths out, but staging
            // everything (`git add -A`) is what resolves them.
            for (const path of index.conflicts.keys()) {
                if (!selected.includes(path) && isSelected(path)) {
                    selected.push(path);
                }
            }
            if (selected.length === 0) return;
            await stagePaths(repo, index, selected, await repo.ignoreRules());
        });
    }

    async getUnstagedFiles(base = "."): Promise<UnstagedFile[]> {
        return this.withSlowNotice(async () => {
            const repo = await this.repo();
            const { index, mtime } = await repo.readIndex();
            return unstagedChanges(
                repo,
                index,
                mtime,
                await repo.ignoreRules(),
                base
            );
        });
    }

    async unstage(filepath: string, relativeToVault: boolean): Promise<void> {
        const gitPath = this.getRelativeRepoPath(filepath, relativeToVault);
        await this.withIndex(true, (repo, index) =>
            resetPaths(repo, index, [gitPath])
        );
    }

    async unstageAll({
        dir,
        status,
    }: {
        dir?: string;
        status?: Status;
    }): Promise<void> {
        const staged = status
            ? status.staged.map((file) => file.path)
            : (await this.getStagedFiles(dir ?? ".")).map(({ path }) => path);
        await this.withIndex(true, (repo, index) =>
            resetPaths(repo, index, staged)
        );
    }

    async discard(filepath: string): Promise<void> {
        await this.withIndex(true, (repo, index) =>
            restoreFromIndex(repo, index, [filepath])
        );
    }

    async discardAll({
        dir,
        status,
    }: {
        dir?: string;
        status?: Status;
    }): Promise<void> {
        let files: string[];
        if (status) {
            files = status.changed
                .filter(
                    (file) =>
                        file.workingDir != "U" &&
                        (dir == undefined ||
                            file.path === dir ||
                            file.path.startsWith(dir.replace(/\/$/, "") + "/"))
                )
                .map((file) => file.path);
        } else {
            files = (await this.getUnstagedFiles(dir))
                .filter((file) => file.type != "A")
                .map(({ path }) => path);
        }
        if (files.length === 0) return;
        await this.withIndex(true, (repo, index) =>
            restoreFromIndex(repo, index, files)
        );
    }

    async commitAll({
        message,
        status,
        unstagedFiles,
        selection,
        amend,
    }: {
        message: string;
        status?: Status;
        unstagedFiles?: FileStatusResult[];
        selection?: AutoCommitGlobSelection;
        amend?: boolean;
    }): Promise<number> {
        await this.assertCloneFinished();
        await this.checkAuthorInfo();
        await this.stageAll({ status, unstagedFiles, selection });
        return this.commit({ message, amend });
    }

    async commit({
        message,
        amend,
    }: {
        message: string;
        amend?: boolean;
    }): Promise<number> {
        return this.withGitOperation(GitOperation.commit, async () => {
            await this.assertCloneFinished();
            try {
                const { name, email } = await this.checkAuthorInfo();
                const formatMessage = await this.formatCommitMessage(message);
                const mergeHeads = await this.getMergeHeads();
                const oid = await this.withIndex(false, async (repo, index) => {
                    const tree = await writeTree(repo, index);
                    const head = await repo.headOid();
                    const committer = person(name, email);
                    let author = committer;
                    let parents: string[];
                    if (amend) {
                        if (mergeHeads.length > 0) {
                            throw new Error(
                                "You are in the middle of a merge -- cannot amend."
                            );
                        }
                        if (!head)
                            throw new Error("There is no commit to amend.");
                        const previous = await repo.objects.readCommit(head);
                        parents = previous.parents;
                        author = previous.author;
                    } else {
                        parents = head ? [head, ...mergeHeads] : [];
                        // Like git (and the native backend), nothing staged
                        // means no commit.
                        const unchanged = head
                            ? (await repo.objects.readCommit(head)).tree ===
                              tree
                            : index.entries.size === 0;
                        if (unchanged && mergeHeads.length === 0) {
                            return undefined;
                        }
                    }
                    const commit = await writeCommit(repo, {
                        tree,
                        parents,
                        message: cleanMessage(formatMessage),
                        author,
                        committer,
                    });
                    await updateHead(repo, commit);
                    return commit;
                });
                if (oid === undefined) return 0;
                const committedFiles = await this.getCommittedFilesCount(oid);
                await this.clearMergeState();
                this.plugin.setPluginState({ mergeInProgress: false });
                return committedFiles;
            } catch (error) {
                if (error instanceof UnmergedPathsError) {
                    throw new GitConflictError(error.filepaths, error);
                }
                throw error;
            }
        });
    }

    private async getCommittedFilesCount(oid: string): Promise<number> {
        const repo = await this.repo();
        const commit = await repo.objects.readCommit(oid);
        const parent = commit.parents[0];
        if (!parent) return (await repo.flatten(commit.tree)).size;
        return (await this.getFileChangesCount(parent, oid)).length;
    }

    private async getMergeHeads(): Promise<string[]> {
        const path = this.getMergeStatePath(WasmGit.MERGE_HEAD);
        if (!(await this.app.vault.adapter.exists(path))) return [];
        return (await this.app.vault.adapter.read(path))
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line.length > 0);
    }

    private async clearMergeState(): Promise<void> {
        const adapter = this.app.vault.adapter;
        for (const filename of [
            WasmGit.MERGE_HEAD,
            WasmGit.MERGE_MESSAGE,
            WasmGit.MERGE_MODE,
        ]) {
            const path = this.getMergeStatePath(filename);
            if (await adapter.exists(path)) await adapter.remove(path);
        }
    }

    // ---- Branches and remotes ----

    /** Move the working tree, index and HEAD to `ref` (a full ref name or oid). */
    private async switchTo(target: string, headRef: string | undefined) {
        await this.withIndex(true, async (repo, index, mtime) => {
            const oid = await repo.resolveCommit(target);
            const from = (await repo.headOid())
                ? await repo.commitTree("HEAD")
                : undefined;
            const to = (await repo.objects.readCommit(oid)).tree;
            const notice = repo.objects.onMissing
                ? this.showNotice("Checking out")
                : undefined;
            try {
                await this.prefetchForCheckout(
                    repo,
                    from,
                    to,
                    notice,
                    "Checking out"
                );
            } finally {
                notice?.hide();
            }
            await checkoutTree(
                repo,
                index,
                mtime,
                await repo.ignoreRules(),
                from,
                to
            );
            if (headRef) await repo.refs.writeSymbolic("HEAD", headRef);
            else await repo.refs.write("HEAD", oid);
        });
    }

    async checkout(branch: string, remote?: string): Promise<void> {
        return this.withGitOperation(GitOperation.checkout, async () => {
            const repo = await this.repo();
            const branches = await repo.refs.list("refs/heads/");
            if (!remote) {
                if (branches.includes(branch)) {
                    return this.switchTo(
                        `refs/heads/${branch}`,
                        `refs/heads/${branch}`
                    );
                }
                // Like `git checkout <name>`: create a tracking branch when
                // exactly one remote has a branch of that name.
                const candidates: string[] = [];
                for (const r of await this.getRemotes()) {
                    if (
                        (await repo.refs.readRaw(
                            `refs/remotes/${r}/${branch}`
                        )) !== null
                    )
                        candidates.push(r);
                }
                if (candidates.length !== 1) {
                    throw new NotFoundError(`branch ${branch}`);
                }
                remote = candidates[0]!;
            }
            const remoteBranch = `${remote}/${branch}`;
            const config = await repo.readConfig();
            const tracksRemote =
                branches.includes(branch) &&
                config.get(`branch.${branch}.remote`) === remote &&
                config.get(`branch.${branch}.merge`) === `refs/heads/${branch}`;
            if (tracksRemote) {
                return this.switchTo(
                    `refs/heads/${branch}`,
                    `refs/heads/${branch}`
                );
            }
            const local = availableBranchName(branch, remote, branches);
            const localRef = `refs/heads/${local}`;
            const tip = await repo.resolveCommit(
                `refs/remotes/${remoteBranch}`
            );
            const clash = await repo.refs.clash(localRef);
            if (clash) {
                throw new Error(
                    `Cannot create branch '${local}' because '${clash}' exists.`
                );
            }
            // Create the branch, then switch; if local changes block the
            // switch, remove it again so nothing has changed.
            await repo.refs.write(localRef, tip);
            try {
                await this.switchTo(localRef, localRef);
            } catch (e) {
                await repo.refs.delete(localRef);
                throw e;
            }
            config.set(`branch.${local}.remote`, remote);
            config.set(`branch.${local}.merge`, `refs/heads/${branch}`);
            await repo.writeConfig(config);
        });
    }

    async createBranch(branch: string): Promise<void> {
        assertBranchName(branch);
        const repo = await this.repo();
        if ((await repo.refs.readRaw(`refs/heads/${branch}`)) !== null) {
            throw new Error(`A branch named '${branch}' already exists.`);
        }
        const clash = await repo.refs.clash(`refs/heads/${branch}`);
        if (clash) {
            throw new Error(
                `Cannot create branch '${branch}' because '${clash}' exists.`
            );
        }
        const head = await repo.headOid();
        if (head) await repo.refs.write(`refs/heads/${branch}`, head);
        await repo.refs.writeSymbolic("HEAD", `refs/heads/${branch}`);
    }

    async deleteBranch(branch: string, force: boolean): Promise<void> {
        const repo = await this.repo();
        const ref = `refs/heads/${branch}`;
        const tip = await repo.refs.resolveFull(ref);
        if (!tip) throw new NotFoundError(`branch ${branch}`);
        if ((await repo.refs.currentBranch()) === branch) {
            throw new Error(
                `Cannot delete branch '${branch}' checked out in the vault.`
            );
        }
        if (!force && !(await this.branchIsMerged(branch))) {
            throw new Error(
                `The branch '${branch}' is not fully merged. Delete it with force to discard its commits.`
            );
        }
        await repo.refs.delete(ref);
        const config = await repo.readConfig();
        config.removeSection("branch", branch);
        await repo.writeConfig(config);
    }

    /**
     * Whether the branch tip is contained in its upstream, or in HEAD when it
     * has none: the check `git branch -d` makes before deleting.
     */
    async branchIsMerged(branch: string): Promise<boolean> {
        const repo = await this.repo();
        const tip = await repo.refs.resolveFull(`refs/heads/${branch}`);
        if (!tip) return false;
        const config = await repo.readConfig();
        const remote = config.get(`branch.${branch}.remote`);
        const merge = config.get(`branch.${branch}.merge`);
        let target: string | undefined;
        if (remote && merge?.startsWith("refs/heads/")) {
            target =
                (await repo.refs.resolveFull(
                    `refs/remotes/${remote}/${merge.slice("refs/heads/".length)}`
                )) ?? undefined;
        }
        target ??= await repo.headOid();
        if (!target) return false;
        return isAncestor(repo, tip, target);
    }

    async setRemote(name: string, url: string): Promise<void> {
        const repo = await this.repo();
        const config = await repo.readConfig();
        if (!config.subsections("remote").includes(name)) {
            config.set(
                `remote.${name}.fetch`,
                `+refs/heads/*:refs/remotes/${name}/*`
            );
        }
        config.set(`remote.${name}.url`, url);
        await repo.writeConfig(config);
    }

    async removeRemote(remoteName: string): Promise<void> {
        const repo = await this.repo();
        const config = await repo.readConfig();
        if (!config.subsections("remote").includes(remoteName)) {
            throw new NotFoundError(`remote ${remoteName}`);
        }
        config.removeSection("remote", remoteName);
        // Like `git remote remove`: forget upstreams pointing at it.
        for (const branch of config.subsections("branch")) {
            if (config.get(`branch.${branch}.remote`) === remoteName) {
                config.set(`branch.${branch}.remote`, undefined);
                config.set(`branch.${branch}.merge`, undefined);
            }
            if (config.get(`branch.${branch}.pushRemote`) === remoteName) {
                config.set(`branch.${branch}.pushRemote`, undefined);
            }
        }
        if (config.get("remote.pushDefault") === remoteName) {
            config.set("remote.pushDefault", undefined);
        }
        await repo.writeConfig(config);
        for (const name of await repo.refs.list(
            `refs/remotes/${remoteName}/`
        )) {
            await repo.refs.delete(`refs/remotes/${remoteName}/${name}`);
        }
    }

    // ---- Network ----

    /** Performs HTTP requests; tests replace it with one backed by Node's fetch. */
    http: HttpClient = async ({ url, method, headers, body }) => {
        const res = await requestUrl({
            url,
            method,
            // Ask the server not to compress: the protocol parser needs the
            // raw bytes, and not every platform inflates transparently.
            headers: { "Accept-Encoding": "identity", ...headers },
            body: body ? toArrayBuffer(body) : undefined,
            throw: false,
        });
        return {
            status: res.status,
            headers: res.headers,
            body: new Uint8Array(await inflateIfGzipped(res.arrayBuffer)),
        };
    };

    private authCallbacks(): AuthCallbacks {
        return {
            onAuth: () => ({
                username: this.plugin.localStorage.getUsername() ?? undefined,
                password: this.plugin.gitServerPassword.get() ?? undefined,
            }),
            onAuthFailure: async () => {
                new Notice(
                    "Authentication failed. Please try with different credentials"
                );
                const username = await new GeneralModal(this.plugin, {
                    placeholder: "Specify your username",
                }).openAndGetResult();
                if (username) {
                    const password = await new GeneralModal(this.plugin, {
                        placeholder:
                            "Specify your password/personal access token",
                        obscure: true,
                    }).openAndGetResult();
                    if (password) {
                        this.plugin.localStorage.setUsername(username);
                        await this.plugin.gitServerPassword.set(password);
                        return { username, password };
                    }
                }
                return { cancel: true };
            },
        };
    }

    private async remoteOptions(
        remote: string,
        notice: Notice | undefined,
        action: string
    ) {
        const url = await this.getRemoteUrl(remote);
        if (!url) throw new NotFoundError(`remote ${remote}`);
        if (!/^https?:\/\//.test(url)) {
            throw new Error(
                `Only HTTP(S) remotes are supported on mobile, but ${remote} is ${url}`
            );
        }
        return {
            url,
            http: this.http,
            auth: this.authCallbacks(),
            onProgress: notice
                ? (message: string) => {
                      const last = message
                          .split(/[\r\n]/)
                          .filter(Boolean)
                          .last();
                      if (last) notice.setMessage(`${action}: ${last}`);
                  }
                : undefined,
        };
    }

    async fetch(remote?: string): Promise<void> {
        const progressNotice = this.showNotice("Initializing fetch");
        try {
            const repo = await this.repo();
            const name = remote ?? (await this.getCurrentRemote());
            const config = await repo.readConfig();
            const refspecs = config.getAll(`remote.${name}.fetch`);
            await fetchRemote(repo, {
                ...(await this.remoteOptions(name, progressNotice, "Fetching")),
                remote: name,
                refspecs:
                    refspecs.length > 0
                        ? refspecs
                        : [`+refs/heads/*:refs/remotes/${name}/*`],
                // A partial clone stays partial: contents come on demand.
                filter:
                    config.get(`remote.${name}.promisor`) === "true"
                        ? (config.get(`remote.${name}.partialclonefilter`) ??
                          "blob:none")
                        : undefined,
            });
        } finally {
            progressNotice?.hide();
        }
    }

    async push(): Promise<PushResult> {
        const progressNotice = this.showNotice("Initializing push");
        return this.withGitOperation(GitOperation.push, async () => {
            await this.assertCloneFinished();
            try {
                const { tracking, current, remote } = await this.branchInfo();
                if (!current) return { status: "blocked", reason: "no-branch" };
                if (!tracking) {
                    this.plugin.log("No tracking branch found. Ignoring push.");
                    return { status: "skipped", reason: "no-upstream" };
                }
                const numChangedFiles = (
                    await this.getFileChangesCount(current, tracking)
                ).length;
                const repo = await this.repo();
                const merge =
                    (await repo.readConfig()).get(`branch.${current}.merge`) ??
                    `refs/heads/${current}`;
                const outcome = await this.pushTo(
                    remote,
                    current,
                    merge,
                    progressNotice
                );
                return outcome === "up-to-date" || numChangedFiles === 0
                    ? { status: "up-to-date" }
                    : { status: "pushed", files: numChangedFiles };
            } finally {
                progressNotice?.hide();
            }
        });
    }

    /** Push a local branch and record the result in the remote-tracking ref. */
    private async pushTo(
        remote: string,
        branch: string,
        remoteRef: string,
        notice?: Notice
    ) {
        const repo = await this.repo();
        const outcome = await pushRef(repo, {
            ...(await this.remoteOptions(remote, notice, "Pushing")),
            localRef: `refs/heads/${branch}`,
            remoteRef,
        });
        // Record what was pushed, not the branch tip now: a commit made
        // during the push has not reached the remote.
        const tracking = remoteRef.replace(
            /^refs\/heads\//,
            `refs/remotes/${remote}/`
        );
        if (tracking !== remoteRef)
            await repo.refs.write(tracking, outcome.oid);
        return outcome.status;
    }

    async updateUpstreamBranch(remoteBranch: string): Promise<void> {
        const [remote, branch] = splitRemoteBranch(remoteBranch);
        const repo = await this.repo();
        const current = await repo.refs.currentBranch();
        if (!current)
            throw new Error("No current branch to set an upstream for.");
        // Like `push --set-upstream` when the remote branch does not exist yet.
        if (
            (await repo.refs.readRaw(`refs/remotes/${remote}/${branch}`)) ===
            null
        ) {
            await this.pushTo(remote, current, `refs/heads/${branch}`);
        }
        const config = await repo.readConfig();
        config.set(`branch.${current}.remote`, remote);
        config.set(`branch.${current}.merge`, `refs/heads/${branch}`);
        await repo.writeConfig(config);
    }

    private showNotice(message: string): Notice | undefined {
        if (this.plugin.settings.disablePopups) return undefined;
        return new Notice(message, this.noticeLength);
    }

    // ---- Merging ----

    async pull(): Promise<PullResult> {
        return this.withGitOperation(GitOperation.pull, async () => {
            await this.assertCloneFinished();
            if (await this.isMergeInProgress()) {
                throw new Error(
                    "Cannot pull because a merge is still in progress. Commit or abort it first."
                );
            }
            const branchInfo = await this.branchInfo();
            if (!branchInfo.current) {
                throw new Error("No current branch found. Cannot pull.");
            }
            const localCommit = await this.resolveRef(branchInfo.current);
            if (!branchInfo.tracking) {
                this.plugin.log("No tracking branch found. Ignoring pull.");
                return { status: "skipped", reason: "no-upstream" };
            }

            await this.fetch();

            const theirs = await this.resolveRef(branchInfo.tracking);
            if (localCommit === theirs) return { status: "up-to-date" };
            const { name, email } = await this.checkAuthorInfo();
            const repo = await this.repo();
            if (await isAncestor(repo, theirs, localCommit)) {
                return { status: "up-to-date" };
            }
            const message = `Merge branch '${branchInfo.tracking}' into ${branchInfo.current}`;
            const localTree = await repo.commitTree(localCommit);
            const pullNotice = repo.objects.onMissing
                ? this.showNotice("Pulling")
                : undefined;
            try {
                await this.prefetchForCheckout(
                    repo,
                    localTree,
                    await repo.commitTree(theirs),
                    pullNotice,
                    "Pulling"
                );
            } finally {
                pullNotice?.hide();
            }

            let result: string;
            if (await isAncestor(repo, localCommit, theirs)) {
                result = theirs;
            } else {
                const bases = await mergeBases(repo, localCommit, theirs);
                if (bases.length === 0) {
                    throw new Error(
                        `Cannot pull: refusing to merge unrelated histories (${branchInfo.current} and ${branchInfo.tracking} share no commit).`
                    );
                }
                if (bases.length > 1) {
                    // Picking one base could silently undo a resolution made
                    // on either side (criss-cross merges).
                    throw new Error(
                        `Cannot pull: ${branchInfo.current} and ${branchInfo.tracking} have ${bases.length} merge bases. Merge them on a device with Git.`
                    );
                }
                const merge = await mergeTrees(
                    repo,
                    await repo.commitTree(bases[0]!),
                    localTree,
                    await repo.commitTree(theirs),
                    {
                        strategy: this.plugin.settings.mergeStrategy,
                        labels: { ours: "HEAD", theirs: branchInfo.tracking },
                    }
                );
                if (merge.conflicts.length > 0) {
                    // Writing conflicts touches the whole tree, so only do it
                    // when no local work could be lost.
                    await this.ensureCleanPullWorktree(localCommit, true);
                    await this.ensureNoIncomingFileCollisions(
                        await this.getFileChangesCount(localCommit, theirs)
                    );
                    await this.materializeConflicts(
                        localTree,
                        merge.merged,
                        merge.conflicts
                    );
                    await this.writeMergeState({
                        ours: localCommit,
                        theirs,
                        message,
                    });
                    const files = merge.conflicts.map((c) => c.path);
                    throw new GitConflictError(
                        files,
                        new MergeConflictError(files)
                    );
                }
                const me = person(name, email);
                result = await writeCommit(repo, {
                    tree: await writeFlatTree(repo, merge.merged),
                    parents: [localCommit, theirs],
                    message: `${message}\n`,
                    author: me,
                    committer: me,
                });
            }

            const resultTree = await repo.commitTree(result);
            const changedFiles = await repo.diffTrees(localTree, resultTree);
            if (changedFiles.length > 0) {
                const filepaths = changedFiles.map((file) => file.path);
                await this.ensureNoIncomingFileCollisions(changedFiles);
                await this.ensureCleanPullWorktree(
                    localCommit,
                    true,
                    filepaths
                );
                await this.withIndex(true, async (r, index, mtime) => {
                    try {
                        await checkoutTree(
                            r,
                            index,
                            mtime,
                            await r.ignoreRules(),
                            localTree,
                            resultTree,
                            { filepaths }
                        );
                    } catch (e) {
                        if (e instanceof CheckoutConflictError) {
                            // eslint-disable-next-line preserve-caught-error -- Error.cause is unavailable with the project's ES2021 target.
                            throw new Error(
                                `Cannot pull with uncommitted working tree changes: ${e.filepaths.join(", ")}`
                            );
                        }
                        throw e;
                    }
                });
            }
            // HEAD moves only once the working tree has the result.
            await repo.refs.write(`refs/heads/${branchInfo.current}`, result);
            return {
                status: "updated",
                outsideVault: 0,
                files: changedFiles.map<FileStatusResult>((file) => ({
                    path: file.path,
                    workingDir: "P",
                    index: "P",
                    vaultPath: this.getRelativeVaultPath(file.path),
                })),
            };
        });
    }

    private async ensureCleanPullWorktree(
        ref: string,
        checkIndex = false,
        filepaths?: string[]
    ): Promise<void> {
        const rows = await (await this.repo()).statusMatrix({ ref, filepaths });
        const changed = rows
            .filter(
                ([, head, workdir, stage]) =>
                    head !== workdir || (checkIndex && head !== stage)
            )
            .map(([filepath]) => filepath);
        if (changed.length > 0) {
            throw new Error(
                `Cannot pull with uncommitted working tree changes: ${changed.join(", ")}`
            );
        }
    }

    private async ensureNoIncomingFileCollisions(
        files: WalkDifference[]
    ): Promise<void> {
        // Ignored untracked files are absent from the status matrix.
        for (const file of files) {
            if (
                file.type === "A" &&
                (await this.app.vault.adapter.exists(
                    this.getRelativeVaultPath(file.path)
                ))
            ) {
                throw new Error(
                    `Cannot pull because an untracked file would be overwritten: ${file.path}`
                );
            }
        }
    }

    /**
     * Put a conflicted merge into the working tree and index: clean results
     * as usual, conflicted files with markers (or the surviving side) and
     * their base/ours/theirs entries as index stages 1–3.
     */
    private async materializeConflicts(
        localTree: string,
        merged: Map<string, FlatEntry>,
        conflicts: Conflict[]
    ): Promise<void> {
        await this.withIndex(true, async (repo, index, mtime) => {
            const tentative = await writeFlatTree(repo, merged);
            await checkoutTree(
                repo,
                index,
                mtime,
                await repo.ignoreRules(),
                localTree,
                tentative
            );
            for (const c of conflicts) {
                if (c.worktree) {
                    await repo.fs.write(repo.vaultPath(c.path), c.worktree);
                }
                index.entries.delete(c.path);
                const stages: IndexEntry[] = [];
                ([c.base, c.ours, c.theirs] as const).forEach((e, i) => {
                    if (!e) return;
                    stages.push({
                        path: c.path,
                        oid: e.oid,
                        mode: parseInt(e.mode, 8),
                        ctimeSec: 0,
                        ctimeNsec: 0,
                        mtimeSec: 0,
                        mtimeNsec: 0,
                        dev: 0,
                        ino: 0,
                        uid: 0,
                        gid: 0,
                        size: 0,
                        stage: i + 1,
                        assumeValid: false,
                        skipWorktree: false,
                        intentToAdd: false,
                    });
                });
                index.conflicts.set(c.path, stages);
            }
        });
        this.plugin.setPluginState({ mergeInProgress: true });
    }

    private async writeMergeState({
        ours,
        theirs,
        message,
    }: {
        ours: string;
        theirs: string;
        message: string;
    }): Promise<void> {
        const adapter = this.app.vault.adapter;
        await adapter.write(
            this.getMergeStatePath(WasmGit.ORIGINAL_HEAD),
            `${ours}\n`
        );
        await adapter.write(
            this.getMergeStatePath(WasmGit.MERGE_MESSAGE),
            `${message}\n`
        );
        await adapter.write(this.getMergeStatePath(WasmGit.MERGE_MODE), "");
        // MERGE_HEAD is written last because its presence marks the merge as active.
        await adapter.write(
            this.getMergeStatePath(WasmGit.MERGE_HEAD),
            `${theirs}\n`
        );
    }

    // ---- Creating repositories ----

    /** Create an empty repository at the configured location (`git init`). */
    async init(): Promise<void> {
        await this.initAt(await this.repo());
    }

    private async initAt(repo: Repository): Promise<void> {
        if (await repo.exists()) return;
        const fs = repo.fs;
        for (const dir of [
            "objects/info",
            "objects/pack",
            "refs/heads",
            "refs/tags",
        ]) {
            await fs.mkdirp(`${repo.gitdir}/${dir}`);
        }
        await repo.refs.writeSymbolic("HEAD", "refs/heads/main");
        const config = await repo.readConfig();
        config.set("core.repositoryformatversion", "0");
        config.set("core.filemode", "false");
        config.set("core.bare", "false");
        config.set("core.logallrefupdates", "true");
        config.set("core.symlinks", "false");
        // Phone and macOS storage is case-insensitive.
        config.set("core.ignorecase", "true");
        await repo.writeConfig(config);
    }

    /**
     * Clone `url` into vault folder `dir` ("." for the vault root): init,
     * fetch (shallow with `depth`), create the remote's default branch with
     * its upstream, and check it out. Untracked files in the way are not
     * overwritten; the clone stops before writing any file instead.
     *
     * Where the server supports it, the clone is partial: commits and folders
     * first, then the current files' contents in batches small enough to hold
     * in memory (older versions are downloaded when needed). If the download
     * is interrupted, the next clone of the same URL resumes it.
     */
    async clone(
        url: string,
        dir: string,
        depth?: number,
        opts: { beforeCheckout?: () => Promise<void> } = {}
    ): Promise<void> {
        const progressNotice = this.showNotice("Initializing clone");
        try {
            const root = dir === "." || dir === "" ? "" : normalizePath(dir);
            const gitdir = normalizePath(
                root
                    ? `${root}/${this.plugin.settings.gitDir || ".git"}`
                    : this.plugin.settings.gitDir || ".git"
            );
            const repo = await new Repository(this.app.vault, {
                root,
                gitdir,
                rangeReader: this.rangeReader,
            }).ready();
            const marker = `${gitdir}/${CLONE_MARKER}`;
            const unfinished = (await repo.fs.readText(marker))?.trim();
            if (unfinished !== undefined && unfinished !== url) {
                // An unfinished clone of another remote holds no work of the
                // user's: start over instead of being stuck with it.
                await repo.fs.rmdir(gitdir, true);
            }
            const resuming = unfinished === url;
            if (resuming) {
                // Packs being written when the app was closed.
                const packDir = repo.objects.packDir;
                for (const f of (await repo.fs.list(packDir)).files) {
                    if (f.startsWith("tmp_pack_")) {
                        await repo.fs.remove(`${packDir}/${f}`);
                    }
                }
            }
            if (!resuming && (await repo.exists())) {
                throw new Error(`A repository already exists in ${dir}.`);
            }
            let resumable = resuming;
            try {
                await this.cloneInto(
                    repo,
                    url,
                    depth,
                    progressNotice,
                    resuming,
                    () => (resumable = true),
                    opts.beforeCheckout
                );
                await repo.fs.remove(marker);
            } catch (e) {
                // Leave nothing behind, so the clone can simply be retried
                // and a half-made repository is never mistaken for a real one.
                // Once contents are downloading, keep them for a resume.
                if (!resumable) {
                    await repo.fs.rmdir(gitdir, true).catch(() => undefined);
                    throw e;
                }
                // eslint-disable-next-line preserve-caught-error -- Error.cause is unavailable with the project's ES2021 target.
                throw new Error(
                    `The clone did not finish: ${e instanceof Error ? e.message : String(e)} Run the clone again to resume it.`
                );
            } finally {
                this.cachedRepo = undefined;
            }
        } finally {
            progressNotice?.hide();
        }
    }

    private async cloneInto(
        repo: Repository,
        url: string,
        depth: number | undefined,
        progressNotice: Notice | undefined,
        resuming: boolean,
        markResumable: () => void,
        beforeCheckout: (() => Promise<void>) | undefined
    ): Promise<void> {
        const onProgress = progressNotice
            ? (m: string) => {
                  const last = m
                      .split(/[\r\n]/)
                      .filter(Boolean)
                      .last();
                  if (last) progressNotice.setMessage(`Cloning: ${last}`);
              }
            : undefined;
        if (!resuming) {
            await this.initAt(repo);
            const config = await repo.readConfig();
            config.set("remote.origin.url", url);
            config.set(
                "remote.origin.fetch",
                "+refs/heads/*:refs/remotes/origin/*"
            );
            await repo.writeConfig(config);
            // Written first, so even a crash during the first download
            // leaves a clone that the next attempt resumes.
            await repo.fs.write(`${repo.gitdir}/${CLONE_MARKER}`, url);
        }

        // On a resume, this only gets what the remote has added meanwhile.
        const { remoteRefs, filtered } = await fetchRemote(repo, {
            url,
            http: this.http,
            auth: this.authCallbacks(),
            remote: "origin",
            // Tags come along, as with `git clone`.
            refspecs: [
                "+refs/heads/*:refs/remotes/origin/*",
                "+refs/tags/*:refs/tags/*",
            ],
            depth,
            filter: "blob:none",
            onProgress,
        });
        if (filtered) {
            // As `git clone --filter` records it, so Git elsewhere agrees.
            const config = await repo.readConfig();
            config.set("core.repositoryformatversion", "1");
            config.set("extensions.partialclone", "origin");
            config.set("remote.origin.promisor", "true");
            config.set("remote.origin.partialclonefilter", "blob:none");
            await repo.writeConfig(config);
            markResumable();
        }
        await this.enableLazyFetch(repo);
        // The remote's default branch: from the symref capability, else
        // the branch whose tip matches the remote's HEAD.
        const headOid = remoteRefs.refs.get("HEAD");
        const branches = [...remoteRefs.refs.keys()].filter((r) =>
            r.startsWith("refs/heads/")
        );
        const byHead = branches.filter(
            (r) => remoteRefs.refs.get(r) === headOid
        );
        const branchRef =
            remoteRefs.headTarget ??
            ["refs/heads/main", "refs/heads/master"].find((r) =>
                byHead.includes(r)
            ) ??
            byHead[0] ??
            ["refs/heads/main", "refs/heads/master"].find((r) =>
                remoteRefs.refs.has(r)
            ) ??
            [...remoteRefs.refs.keys()].find((r) =>
                r.startsWith("refs/heads/")
            );
        if (!branchRef) return; // empty remote: an empty repository
        const branch = branchRef.slice("refs/heads/".length);
        const tip = await repo.resolveCommit(`refs/remotes/origin/${branch}`);
        const tree = (await repo.objects.readCommit(tip)).tree;
        await repo.refs.writeSymbolic("HEAD", branchRef);
        await this.prefetchForCheckout(
            repo,
            undefined,
            tree,
            progressNotice,
            "Cloning"
        );
        if (beforeCheckout) {
            // Check for files in the way first: `beforeCheckout` may delete
            // the config folder, and with it this plugin.
            const configDir = this.app.vault.configDir;
            try {
                await checkoutTree(
                    repo,
                    new GitIndex(),
                    0,
                    await repo.ignoreRules(),
                    undefined,
                    tree,
                    { checkOnly: true }
                );
            } catch (e) {
                if (!(e instanceof CheckoutConflictError)) throw e;
                const inTheWay = e.filepaths.filter(
                    (f) => f !== configDir && !f.startsWith(`${configDir}/`)
                );
                if (inTheWay.length > 0) {
                    throw new CheckoutConflictError(inTheWay);
                }
            }
            await beforeCheckout();
        }
        const index = new GitIndex();
        await checkoutTree(
            repo,
            index,
            0,
            await repo.ignoreRules(),
            undefined,
            tree,
            {
                onProgress: (done, total) =>
                    progressNotice?.setMessage(
                        `Cloning: writing files ${done.toLocaleString()} / ${total.toLocaleString()}`
                    ),
            }
        );
        await repo.writeIndex(index);
        await repo.refs.write(branchRef, tip);
        const cfg = await repo.readConfig();
        cfg.set(`branch.${branch}.remote`, "origin");
        cfg.set(`branch.${branch}.merge`, branchRef);
        await repo.writeConfig(cfg);
    }
}
