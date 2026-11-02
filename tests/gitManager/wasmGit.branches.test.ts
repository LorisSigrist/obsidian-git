import path from "path";
import { execFileSync } from "child_process";
import { readFileSync } from "fs";
import { withCleanup } from "../helpers/cleanup";
import {
    createRepoWithMergeConflict,
    createRepoWithOrigin,
    type TestRepo,
} from "../helpers/gitRepo";
import {
    managerFor,
    nativeStatus,
    ourStatus,
    expectFsckClean,
} from "../helpers/wasmGitFixtures";
import { describe, expect, it } from "vitest";

describe("WasmGit branches and remotes", { timeout: 300_000 }, () => {
    /** main has note.md + dir/keep.md + gone/x.md; feature changes, adds and deletes. */
    async function branchedRepo(): Promise<TestRepo> {
        const repo = await createRepoWithOrigin();
        await repo.writeAndCommit("dir/keep.md", "keep\n", "keep");
        await repo.writeAndCommit("gone/x.md", "x\n", "x");
        await repo.writeAndCommit("local.md", "base\n", "local");
        await repo.git.checkoutLocalBranch("feature");
        await repo.writeAndCommit("note.md", "feature\n", "feature note");
        await repo.writeAndCommit("added/new.md", "new\n", "added");
        await repo.raw(["rm", "-q", "-r", "gone"]);
        await repo.git.commit("remove gone");
        await repo.git.checkout("main");
        return repo;
    }

    const read = (repo: TestRepo, p: string) =>
        readFileSync(path.join(repo.repoPath, p), "utf8");
    const exists = (repo: TestRepo, p: string) => {
        try {
            readFileSync(path.join(repo.repoPath, p));
            return true;
        } catch {
            return false;
        }
    };

    it("switches branches, keeping unrelated local changes", async () => {
        const repo = withCleanup(await branchedRepo());
        repo.write("local.md", "my edit\n");
        repo.write("scratch.md", "untracked\n");
        const manager = managerFor(repo);

        await manager.checkout("feature");
        expect(await repo.raw(["branch", "--show-current"])).toBe("feature");
        expect(read(repo, "note.md")).toBe("feature\n");
        expect(read(repo, "added/new.md")).toBe("new\n");
        expect(exists(repo, "gone/x.md")).toBe(false);
        expect(exists(repo, "gone")).toBe(false);
        expect(read(repo, "local.md")).toBe("my edit\n");
        expect(await nativeStatus(repo)).toEqual(
            new Map([
                ["local.md", " M"],
                ["scratch.md", "UU"],
            ])
        );
        expect(await ourStatus(manager)).toEqual(await nativeStatus(repo));

        await manager.checkout("main");
        expect(read(repo, "note.md")).toBe("base\n");
        expect(read(repo, "gone/x.md")).toBe("x\n");
        expect(exists(repo, "added")).toBe(false);
        await expectFsckClean(repo);
    });

    it("refuses to overwrite local changes or untracked files", async () => {
        const repo = withCleanup(await branchedRepo());
        const manager = managerFor(repo);
        repo.write("note.md", "unsaved work\n");
        await expect(manager.checkout("feature")).rejects.toThrow(
            /would be overwritten.*note\.md/
        );
        expect(read(repo, "note.md")).toBe("unsaved work\n");
        expect(await repo.raw(["branch", "--show-current"])).toBe("main");

        repo.write("note.md", "base\n");
        repo.write("added/new.md", "in the way\n");
        await expect(manager.checkout("feature")).rejects.toThrow(
            /added\/new\.md/
        );
        expect(read(repo, "added/new.md")).toBe("in the way\n");

        // An ignored file in the way is replaced, as git does.
        await repo.writeAndCommit(".gitignore", "added/\n", "ignore added");
        await manager.checkout("feature");
        expect(read(repo, "added/new.md")).toBe("new\n");
    });

    it("creates branches and checks out remote branches with an upstream", async () => {
        const repo = withCleanup(await branchedRepo());
        await repo.raw(["push", "--quiet", "origin", "feature"]);
        await repo.raw(["branch", "-q", "-D", "feature"]);
        await repo.raw(["fetch", "--quiet", "origin"]);
        const manager = managerFor(repo);

        await manager.checkout("feature", "origin");
        expect(await repo.raw(["branch", "--show-current"])).toBe("feature");
        expect(
            await repo.raw(["rev-parse", "--abbrev-ref", "feature@{upstream}"])
        ).toBe("origin/feature");
        expect(read(repo, "added/new.md")).toBe("new\n");

        // Switching back to it is a plain switch.
        await manager.checkout("main");
        await manager.checkout("feature", "origin");
        expect(await repo.raw(["branch", "--show-current"])).toBe("feature");

        // A local branch of that name tracking something else gets a new name.
        await repo.raw(["branch", "-q", "--unset-upstream", "feature"]);
        await manager.checkout("main");
        await manager.checkout("feature", "origin");
        expect(await repo.raw(["branch", "--show-current"])).toBe(
            "feature-origin"
        );

        await manager.createBranch("topic/new");
        expect(await repo.raw(["branch", "--show-current"])).toBe("topic/new");
        expect(await repo.raw(["rev-parse", "topic/new"])).toBe(
            await repo.raw(["rev-parse", "feature-origin"])
        );
        await expect(manager.createBranch("topic/new")).rejects.toThrow();
        await expect(manager.createBranch("bad..name")).rejects.toThrow();
        await expectFsckClean(repo);
    });

    it("checks out a branch that only exists on one remote", async () => {
        const repo = withCleanup(await branchedRepo());
        await repo.raw(["push", "--quiet", "origin", "feature"]);
        await repo.raw(["branch", "-q", "-D", "feature"]);
        await repo.raw(["fetch", "--quiet", "origin"]);
        const manager = managerFor(repo);
        await manager.checkout("feature");
        expect(
            await repo.raw(["rev-parse", "--abbrev-ref", "feature@{upstream}"])
        ).toBe("origin/feature");
        await expect(manager.checkout("does-not-exist")).rejects.toThrow();
    });

    it("deletes branches, refusing unmerged ones without force", async () => {
        const repo = withCleanup(await branchedRepo());
        await repo.raw(["branch", "merged"]);
        await repo.raw(["config", "branch.feature.remote", "origin"]);
        const manager = managerFor(repo);

        expect(await manager.branchIsMerged("merged")).toBe(true);
        expect(await manager.branchIsMerged("feature")).toBe(false);
        await manager.deleteBranch("merged", false);
        await expect(manager.deleteBranch("feature", false)).rejects.toThrow(
            /not fully merged/
        );
        await expect(manager.deleteBranch("main", true)).rejects.toThrow();
        await manager.deleteBranch("feature", true);
        expect(await repo.raw(["branch", "--format=%(refname:short)"])).toBe(
            "main"
        );
        expect(
            await repo.raw(["config", "--get-all", "branch.feature.remote"])
        ).toBe("");
    });

    it("adds, updates and removes remotes like git remote", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        await repo.raw(["fetch", "--quiet", "origin"]);
        const manager = managerFor(repo);

        await manager.setRemote("backup", "https://example.com/a.git");
        await manager.setRemote("backup", "https://example.com/b.git");
        expect(await repo.raw(["remote", "get-url", "backup"])).toBe(
            "https://example.com/b.git"
        );
        expect(await repo.raw(["config", "--get", "remote.backup.fetch"])).toBe(
            "+refs/heads/*:refs/remotes/backup/*"
        );
        expect(await manager.getRemotes()).toEqual(["origin", "backup"]);

        await manager.removeRemote("origin");
        expect(await repo.raw(["remote"])).toBe("backup");
        expect(await repo.raw(["branch", "-r"])).toBe("");
        expect(
            await repo.raw(["config", "--get-all", "branch.main.remote"])
        ).toBe("");
    });
});

describe("WasmGit phase 3 review regressions", { timeout: 300_000 }, () => {
    const read = (repo: TestRepo, p: string) =>
        readFileSync(path.join(repo.repoPath, p), "utf8");

    it("handles a case-only rename on case-insensitive storage", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        await repo.git.checkoutLocalBranch("renamed");
        await repo.raw(["mv", "note.md", "Note.md"]);
        await repo.git.commit("rename");
        await repo.raw(["mv", "Note.md", "NOTE.md"]);
        repo.write("NOTE.md", "edited too\n");
        await repo.raw(["add", "-A"]);
        await repo.git.commit("rename and edit");
        await repo.git.checkout("main");
        const manager = managerFor(repo);

        await manager.checkout("renamed");
        expect(await repo.statusPorcelain()).toBe("");
        expect(read(repo, "NOTE.md")).toBe("edited too\n");
        await manager.checkout("main");
        expect(await repo.statusPorcelain()).toBe("");
        expect(read(repo, "note.md")).toBe("base\n");
    });

    it("refuses to switch branches during a merge", async () => {
        const repo = withCleanup(await createRepoWithMergeConflict());
        const manager = managerFor(repo);
        await expect(manager.checkout("other")).rejects.toThrow(
            /resolve your current index/
        );
        expect(await repo.raw(["branch", "--show-current"])).toBe("main");
    });

    it("switches between a folder and a file of the same name", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        await repo.writeAndCommit("a/b.md", "in folder\n", "folder a");
        await repo.writeAndCommit("0.md", "zero\n", "zero");
        await repo.git.checkoutLocalBranch("file-a");
        await repo.raw(["rm", "-q", "-r", "a"]);
        repo.write("a", "a is a file\n");
        repo.write("0.md", "zero changed\n");
        await repo.raw(["add", "-A"]);
        await repo.git.commit("a becomes a file");
        await repo.git.checkout("main");
        const manager = managerFor(repo);

        await manager.checkout("file-a");
        expect(read(repo, "a")).toBe("a is a file\n");
        expect(await repo.statusPorcelain()).toBe("");
        await manager.checkout("main");
        expect(read(repo, "a/b.md")).toBe("in folder\n");
        expect(await repo.statusPorcelain()).toBe("");
    });

    it("refuses up front when untracked files are in the way of folders or files", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        await repo.git.checkoutLocalBranch("adds");
        await repo.writeAndCommit("p/q.md", "q\n", "p/q");
        await repo.writeAndCommit("r", "r is a file\n", "r");
        repo.write("0-first.md", "sorts first\n");
        await repo.raw(["add", "0-first.md"]);
        await repo.git.commit("first");
        await repo.git.checkout("main");
        const manager = managerFor(repo);

        repo.write("p", "untracked file where a folder goes\n");
        await expect(manager.checkout("adds")).rejects.toThrow(/p\/q\.md/);
        expect(await repo.raw(["branch", "--show-current"])).toBe("main");
        execFileSync("rm", [path.join(repo.repoPath, "p")]);

        repo.write("r/mine.md", "untracked note inside a folder\n");
        await expect(manager.checkout("adds")).rejects.toThrow(/\br\b/);
        expect(read(repo, "r/mine.md")).toBe(
            "untracked note inside a folder\n"
        );
        expect(await repo.git.raw(["ls-files", "0-first.md"])).toBe("");
    });

    it("leaves no branch behind when checking out a remote branch fails", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        await repo.raw(["checkout", "-q", "-b", "feature/x"]);
        await repo.writeAndCommit("x.md", "x\n", "x");
        await repo.raw(["push", "-q", "origin", "feature/x"]);
        await repo.raw(["checkout", "-q", "main"]);
        await repo.raw(["branch", "-q", "-D", "feature/x"]);
        await repo.raw(["branch", "feature"]);
        await repo.raw(["fetch", "-q", "origin"]);
        const manager = managerFor(repo);

        await expect(manager.checkout("feature/x", "origin")).rejects.toThrow(
            /feature/
        );
        expect(await repo.raw(["branch", "--show-current"])).toBe("main");
        expect(await repo.raw(["branch", "--format=%(refname:short)"])).toBe(
            "feature\nmain"
        );
    });

    it("validates branch names like git check-ref-format", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        await repo.raw(["branch", "topic"]);
        await repo.raw(["pack-refs", "--all"]);
        const manager = managerFor(repo);
        await expect(manager.createBranch("a.lock/b")).rejects.toThrow();
        await expect(manager.createBranch("topic/x")).rejects.toThrow(/topic/);
        expect(await repo.raw(["branch", "--format=%(refname:short)"])).toBe(
            "main\ntopic"
        );
    });

    it("deletes a branch that is merged into its upstream", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        await repo.raw(["checkout", "-q", "-b", "pushed"]);
        await repo.writeAndCommit("p.md", "p\n", "pushed work");
        await repo.raw(["push", "-q", "-u", "origin", "pushed"]);
        await repo.raw(["checkout", "-q", "main"]);
        const manager = managerFor(repo);
        await manager.deleteBranch("pushed", false);
        expect(await repo.raw(["branch", "--format=%(refname:short)"])).toBe(
            "main"
        );
    });
});
