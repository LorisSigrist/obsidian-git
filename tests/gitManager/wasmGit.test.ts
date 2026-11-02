import { randomBytes } from "crypto";
import { readFileSync, writeFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import type { WasmGit } from "../../src/gitManager/wasmGit";
import type { Repository } from "../../src/gitManager/gitcore/repository";
import { withCleanup } from "../helpers/cleanup";
import { createRepoWithOrigin, type TestRepo } from "../helpers/gitRepo";
import { createWasmGitManager } from "../helpers/wasmGit";

function managerFor(repo: TestRepo): WasmGit {
    return createWasmGitManager(repo.repoPath, {
        vaultPath: repo.dir,
        basePath: "worktree",
    }).manager;
}

function repoOf(manager: WasmGit): Promise<Repository> {
    return (manager as unknown as { repo(): Promise<Repository> }).repo();
}

/** `git status --porcelain` as path → two-letter code, untracked as "UU"-style like the plugin. */
async function nativeStatus(repo: TestRepo): Promise<Map<string, string>> {
    // Not repo.raw(): it trims, which would eat the leading space of " D".
    const out = await repo.git.raw([
        "-c",
        "status.renames=false",
        "status",
        "--porcelain",
        "-uall",
    ]);
    const map = new Map<string, string>();
    for (const line of out.split("\n").filter(Boolean)) {
        const code = line.slice(0, 2).replace(/\?/g, "U");
        map.set(line.slice(3), code);
    }
    return map;
}

async function ourStatus(manager: WasmGit): Promise<Map<string, string>> {
    const status = await manager.status();
    return new Map(status.all.map((f) => [f.path, f.index + f.workingDir]));
}

/** A repository with history, branches, ignore rules and every kind of change. */
async function richRepo(): Promise<TestRepo> {
    const repo = await createRepoWithOrigin();
    await repo.writeAndCommit(
        ".gitignore",
        "*.log\nbuild/\n!keep.log\ndeep/**/secret.md\n",
        "ignore rules"
    );
    await repo.writeAndCommit("dir/a.md", "a\n", "a");
    await repo.writeAndCommit("dir/sub/b.md", "b\n", "b");
    await repo.writeAndCommit(
        "dir/sub/.gitignore",
        "local.md\n",
        "nested ignore"
    );
    await repo.writeAndCommit("deleted.md", "gone soon\n", "to delete");
    await repo.writeAndCommit("staged-then-edited.md", "v1\n", "v1");
    // A tracked file that matches an ignore rule stays tracked.
    repo.write("tracked.log", "tracked\n");
    await repo.raw(["add", "-f", "tracked.log"]);
    await repo.git.commit("tracked log");
    await repo.git.checkoutLocalBranch("feature");
    await repo.writeAndCommit("feature.md", "feature\n", "feature work");
    await repo.git.checkout("main");
    await repo.raw(["merge", "--no-ff", "-m", "merge feature", "feature"]);
    await repo.git.push(["--quiet"]);
    await repo.writeAndCommit("local-only.md", "unpushed\n", "unpushed");
    return repo;
}

async function makeChanges(repo: TestRepo): Promise<void> {
    repo.write("note.md", "modified\n");
    repo.write("dir/sub/b.md", "b changed\n");
    repo.write("new-staged.md", "new\n");
    await repo.raw(["add", "new-staged.md"]);
    repo.write("staged-then-edited.md", "v2\n");
    await repo.raw(["add", "staged-then-edited.md"]);
    repo.write("staged-then-edited.md", "v3\n");
    repo.remove("deleted.md");
    repo.write("untracked.md", "u\n");
    repo.write("dir/untracked-deep/x.md", "x\n");
    repo.write("ignored.log", "ignored\n");
    repo.write("keep.log", "re-included\n");
    repo.write("build/out.md", "ignored dir\n");
    repo.write("deep/a/b/secret.md", "ignored glob\n");
    repo.write("dir/sub/local.md", "ignored by nested file\n");
    repo.write("tracked.log", "tracked and changed\n");
    repo.write(".obsidian/workspace.json", "{}\n");
}

describe("WasmGit read-only operations", () => {
    it("reports the same status as git, with loose objects", async () => {
        const repo = withCleanup(await richRepo());
        await makeChanges(repo);
        const manager = managerFor(repo);
        expect(await ourStatus(manager)).toEqual(await nativeStatus(repo));
    });

    it("reports the same status as git with packed objects, packed refs and a v4 index", async () => {
        const repo = withCleanup(await richRepo());
        await repo.raw(["gc", "--quiet", "--aggressive"]);
        await repo.raw(["update-index", "--index-version", "4"]);
        await makeChanges(repo);
        const manager = managerFor(repo);
        expect(await ourStatus(manager)).toEqual(await nativeStatus(repo));
    });

    it("limits status to a directory", async () => {
        const repo = withCleanup(await richRepo());
        await makeChanges(repo);
        const manager = managerFor(repo);
        const status = await manager.status({ path: "dir" });
        expect(status.all.map((f) => f.path).sort()).toEqual([
            "dir/sub/b.md",
            "dir/untracked-deep/x.md",
        ]);
    });

    it("lists untracked paths", async () => {
        const repo = withCleanup(await richRepo());
        await makeChanges(repo);
        const manager = managerFor(repo);
        expect((await manager.getUntrackedPaths({})).sort()).toEqual([
            ".obsidian/workspace.json",
            "dir/untracked-deep/x.md",
            "keep.log",
            "untracked.md",
        ]);
    });

    it("logs the same commits as git, newest first, with merges", async () => {
        const repo = withCleanup(await richRepo());
        await repo.raw(["gc", "--quiet"]);
        const manager = managerFor(repo);

        const ours = await manager.log(undefined);
        const theirs = (await repo.raw(["log", "--format=%H %aI"])).split("\n");
        expect(ours.map((e) => `${e.hash} ${e.date}`)).toEqual(theirs);

        const limited = await manager.log(undefined, true, 3);
        expect(limited.map((e) => e.hash)).toEqual(
            theirs.slice(0, 3).map((l) => l.split(" ")[0])
        );

        const fileLog = await manager.log("worktree/dir/a.md", true);
        expect(fileLog.map((e) => e.hash)).toEqual(
            (await repo.raw(["log", "--format=%H", "--", "dir/a.md"])).split(
                "\n"
            )
        );

        const first = ours.find((e) => e.message === "nested ignore")!;
        expect(first.diff.files).toEqual([
            {
                path: "dir/sub/.gitignore",
                vaultPath: "worktree/dir/sub/.gitignore",
                status: "A",
                hash: first.hash,
            },
        ]);
        const root = ours[ours.length - 1]!;
        expect(root.diff.files.map((f) => [f.path, f.status])).toEqual([
            ["note.md", "A"],
        ]);
    });

    it("shows file contents and diffs at a commit", async () => {
        const repo = withCleanup(await richRepo());
        await repo.appendAndCommit("dir/a.md", "more\n", "grow a");
        await repo.raw(["gc", "--quiet"]);
        const manager = managerFor(repo);
        const head = await repo.head();

        expect(await manager.show(head, "worktree/dir/a.md")).toBe("a\nmore\n");
        expect(await manager.show(head, "dir/a.md", false)).toBe("a\nmore\n");
        await expect(manager.show(head, "missing.md", false)).rejects.toThrow();

        const diff = await manager.getDiffString("dir/a.md", false, head);
        expect(diff).toContain("+++ worktree/dir/a.md");
        expect(diff).toContain("+more");
    });

    it("diffs staged and unstaged changes", async () => {
        const repo = withCleanup(await richRepo());
        repo.write("dir/a.md", "a\nstaged\n");
        await repo.raw(["add", "dir/a.md"]);
        repo.write("dir/a.md", "a\nstaged\nunstaged\n");
        const manager = managerFor(repo);

        const staged = await manager.getDiffString("dir/a.md", true);
        expect(staged).toContain("+staged");
        expect(staged).not.toContain("+unstaged");
        const unstaged = await manager.getDiffString("dir/a.md", false);
        expect(unstaged).toContain("+unstaged");
        expect(unstaged).not.toContain("+staged");
    });

    it("reads branches, remotes, config and push state like git", async () => {
        const repo = withCleanup(await richRepo());
        await repo.raw(["config", "user.name", "Name With Spaces"]);
        await repo.raw(["pack-refs", "--all"]);
        await repo.raw(["fetch", "--quiet", "origin"]);
        const manager = managerFor(repo);

        expect(await manager.branchInfo()).toMatchObject({
            current: "main",
            tracking: "origin/main",
            branches: ["feature", "main"],
        });
        expect(await manager.getConfig("user.name")).toBe("Name With Spaces");
        expect(await manager.getConfig("branch.main.merge")).toBe(
            "refs/heads/main"
        );
        expect(await manager.getConfig("missing.key")).toBeUndefined();
        expect(await manager.getRemotes()).toEqual(["origin"]);
        expect(await manager.getRemoteUrl("origin")).toBe(repo.remotePath);
        expect(await manager.getRemoteBranches("origin")).toEqual([
            "origin/main",
        ]);
        expect(await manager.canPush()).toBe(true);
        expect(await manager.getUnpushedCommits()).toBe(1);
        expect(await manager.getLastCommitTime()).toEqual(
            new Date(
                Number(await repo.raw(["log", "-1", "--format=%ct"])) * 1000
            )
        );
        expect(await manager.isMergeInProgress()).toBe(false);
        expect(await manager.checkRequirements()).toBe("valid");
    });

    it("reports detached HEAD as no current branch", async () => {
        const repo = withCleanup(await richRepo());
        await repo.raw(["checkout", "--quiet", "--detach", "HEAD~1"]);
        const manager = managerFor(repo);
        expect((await manager.branchInfo()).current).toBeUndefined();
        expect(await manager.canPush()).toBe(false);
    });

    it("reads large packed blobs that span many read blocks", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        const big = randomBytes(3_500_000);
        writeFileSync(path.join(repo.repoPath, "big.bin"), big);
        await repo.raw(["add", "big.bin"]);
        await repo.git.commit("big");
        // A second version stored as a delta against the first.
        big[1_234_567] = big[1_234_567]! ^ 0xff;
        writeFileSync(path.join(repo.repoPath, "big.bin"), big);
        await repo.raw(["add", "big.bin"]);
        await repo.git.commit("big v2");
        await repo.raw(["gc", "--quiet", "--aggressive"]);
        const manager = managerFor(repo);

        const blob = await (
            await repoOf(manager)
        ).readBlobAt("HEAD", "big.bin");
        expect(
            Buffer.from(blob!).equals(
                readFileSync(path.join(repo.repoPath, "big.bin"))
            )
        ).toBe(true);
        const old = await (
            await repoOf(manager)
        ).readBlobAt("HEAD~1", "big.bin");
        expect(old![1_234_567]).toBe(big[1_234_567] ^ 0xff);
        expect(await ourStatus(manager)).toEqual(await nativeStatus(repo));
    });

    it("resolves abbreviated object ids", async () => {
        const repo = withCleanup(await richRepo());
        await repo.raw(["gc", "--quiet"]);
        const manager = managerFor(repo);
        const head = await repo.head();
        expect(await manager.resolveRef(head.slice(0, 8))).toBe(head);
        expect(await manager.resolveRef("feature")).toBe(
            await repo.raw(["rev-parse", "feature"])
        );
        expect(await manager.resolveRef("origin/main")).toBe(
            await repo.raw(["rev-parse", "origin/main"])
        );
    });
});
