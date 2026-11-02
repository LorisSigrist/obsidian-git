import { createPatch } from "diff";
import { normalizePath, Notice } from "obsidian";
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
import { NotFoundError, UnmergedPathsError } from "./gitcore/errors";
import type { GitIndex } from "./gitcore/gitIndex";
import type { Person } from "./gitcore/model";
import type { RangeReader } from "./gitcore/repoFs";
import { Repository, type StatusRow } from "./gitcore/repository";
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
        `${p.timezone.slice(0, 3)}:${p.timezone.slice(3, 5)}`
    );
}

/**
 * The mobile Git backend: a git implementation on Obsidian's file API, with
 * packfile handling, compression and hashing in WASM.
 */
export class WasmGit extends GitManager {
    private static readonly MERGE_HEAD = "MERGE_HEAD";
    private static readonly MERGE_MESSAGE = "MERGE_MSG";
    private static readonly MERGE_MODE = "MERGE_MODE";
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
                }).ready(),
            };
        }
        return this.cachedRepo.repo;
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
        return (await (await this.repo()).exists()) ? "valid" : "missing-repo";
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

    branchIsMerged(_: string): Promise<boolean> {
        return Promise.resolve(true);
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
        await this.withIndex(true, (repo, index) =>
            stagePaths(repo, index, [gitPath], repo.ignoreRules())
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
        if (selected.length === 0) return;
        await this.withIndex(true, (repo, index) =>
            stagePaths(repo, index, selected, repo.ignoreRules())
        );
    }

    async getUnstagedFiles(base = "."): Promise<UnstagedFile[]> {
        return this.withSlowNotice(async () => {
            const repo = await this.repo();
            const { index, mtime } = await repo.readIndex();
            return unstagedChanges(
                repo,
                index,
                mtime,
                repo.ignoreRules(),
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
                        (dir == undefined || file.path.startsWith(dir))
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
                        if (!head)
                            throw new Error("There is no commit to amend.");
                        const previous = await repo.objects.readCommit(head);
                        parents = previous.parents;
                        author = previous.author;
                    } else {
                        parents = head ? [head, ...mergeHeads] : [];
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

    // ---- Not yet implemented (later phases) ----

    private notYet(name: string): never {
        throw new Error(`${name} is not implemented in the WASM backend yet`);
    }

    pull(): Promise<PullResult> {
        this.notYet("pull");
    }
    push(): Promise<PushResult> {
        this.notYet("push");
    }
    checkout(_: string, __?: string): Promise<void> {
        this.notYet("checkout");
    }
    createBranch(_: string): Promise<void> {
        this.notYet("createBranch");
    }
    deleteBranch(_: string, __: boolean): Promise<void> {
        this.notYet("deleteBranch");
    }
    init(): Promise<void> {
        this.notYet("init");
    }
    clone(_: string, __: string, ___?: number): Promise<void> {
        this.notYet("clone");
    }
    fetch(_?: string): Promise<void> {
        this.notYet("fetch");
    }
    setRemote(_: string, __: string): Promise<void> {
        this.notYet("setRemote");
    }
    removeRemote(_: string): Promise<void> {
        this.notYet("removeRemote");
    }
    updateUpstreamBranch(_: string): Promise<void> {
        this.notYet("updateUpstreamBranch");
    }
}
