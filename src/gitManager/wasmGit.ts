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
    WalkDifference,
} from "../types";
import {
    createAutoCommitPathSelector,
    type AutoCommitGlobSelection,
    type AutoCommitSelectedFiles,
} from "../autoCommitGlobs";
import { GitManager } from "./gitManager";
import { NotFoundError } from "./gitcore/errors";
import type { Person } from "./gitcore/model";
import type { RangeReader } from "./gitcore/repoFs";
import { Repository, type StatusRow } from "./gitcore/repository";

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

    // ---- Not yet implemented (later phases) ----

    private notYet(name: string): never {
        throw new Error(`${name} is not implemented in the WASM backend yet`);
    }

    commitAll(_: {
        message: string;
        status?: Status;
        unstagedFiles?: FileStatusResult[];
        selection?: AutoCommitGlobSelection;
        amend?: boolean;
    }): Promise<number> {
        this.notYet("commitAll");
    }
    commit(_: { message: string; amend?: boolean }): Promise<number> {
        this.notYet("commit");
    }
    stageAll(_: { dir?: string; status?: Status }): Promise<void> {
        this.notYet("stageAll");
    }
    unstageAll(_: { dir?: string; status?: Status }): Promise<void> {
        this.notYet("unstageAll");
    }
    stage(_: string, __: boolean): Promise<void> {
        this.notYet("stage");
    }
    unstage(_: string, __: boolean): Promise<void> {
        this.notYet("unstage");
    }
    discard(_: string): Promise<void> {
        this.notYet("discard");
    }
    discardAll(_: { dir?: string; status?: Status }): Promise<void> {
        this.notYet("discardAll");
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
    setConfig(
        _: string,
        __: string | number | boolean | undefined
    ): Promise<void> {
        this.notYet("setConfig");
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
