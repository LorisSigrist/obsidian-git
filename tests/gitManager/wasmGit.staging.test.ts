import path from "path";
import { execFileSync } from "child_process";
import { chmodSync, readFileSync, writeFileSync } from "fs";
import { withCleanup } from "../helpers/cleanup";
import {
    createEmptyRepo,
    createRepoWithMergeConflict,
    createRepoWithOrigin,
} from "../helpers/gitRepo";
import { createWasmGitManager } from "../helpers/wasmGit";
import {
    managerFor,
    nativeStatus,
    ourStatus,
    richRepo,
    makeChanges,
    expectFsckClean,
} from "../helpers/wasmGitFixtures";
import { describe, expect, it } from "vitest";

describe("WasmGit staging and committing", { timeout: 300_000 }, () => {
    it("stages, unstages and discards like git", async () => {
        const repo = withCleanup(await richRepo());
        await makeChanges(repo);
        const manager = managerFor(repo);

        await manager.stage("worktree/note.md", true);
        await manager.stage("deleted.md", false);
        await manager.stage("untracked.md", false);
        await manager.stage("worktree/dir", true);
        await manager.stage("ignored.log", false);
        await manager.unstage("staged-then-edited.md", false);
        await manager.unstage("worktree/new-staged.md", true);

        const native = await nativeStatus(repo);
        expect(native.get("note.md")).toBe("M ");
        expect(native.get("deleted.md")).toBe("D ");
        expect(native.get("untracked.md")).toBe("A ");
        expect(native.get("dir/sub/b.md")).toBe("M ");
        expect(native.get("dir/untracked-deep/x.md")).toBe("A ");
        expect(native.get("staged-then-edited.md")).toBe(" M");
        expect(native.get("new-staged.md")).toBe("UU");
        // Ignored files are not added without force, nested ignores included.
        expect(native.has("ignored.log")).toBe(false);
        expect(
            await repo.raw([
                "ls-files",
                "--",
                "dir/sub/local.md",
                "ignored.log",
            ])
        ).toBe("");
        expect(await ourStatus(manager)).toEqual(native);

        await manager.discard("staged-then-edited.md");
        expect(
            readFileSync(
                path.join(repo.repoPath, "staged-then-edited.md"),
                "utf8"
            )
        ).toBe("v1\n");
        await manager.discardAll({});
        expect(
            readFileSync(path.join(repo.repoPath, "tracked.log"), "utf8")
        ).toBe("tracked\n");
        expect(await ourStatus(manager)).toEqual(await nativeStatus(repo));
        await expectFsckClean(repo);
    });

    it("writes commits, trees and an index that git accepts", async () => {
        const repo = withCleanup(await richRepo());
        await repo.raw(["gc", "--quiet"]);
        await makeChanges(repo);
        repo.write("ünïcödé/日本語.md", "unicode\n");
        repo.write("a b/c d.md", "spaces\n");
        writeFileSync(path.join(repo.repoPath, "script.sh"), "#!/bin/sh\n");
        chmodSync(path.join(repo.repoPath, "script.sh"), 0o755);
        await repo.raw(["add", "script.sh"]);
        await repo.git.commit("exec");
        repo.write("script.sh", "#!/bin/sh\necho\n");
        const manager = managerFor(repo);

        const count = await manager.commitAll({
            message: "everything\n\nbody  ",
        });
        await expectFsckClean(repo);
        expect(await repo.statusPorcelain()).toBe("");
        expect(await repo.raw(["log", "-1", "--format=%B"])).toBe(
            "everything\n\nbody"
        );
        expect(await repo.raw(["log", "-1", "--format=%an <%ae>"])).toBe(
            "Test User <test@example.com>"
        );
        expect(count).toBe(
            (await repo.raw(["diff", "--name-only", "HEAD~1", "HEAD"])).split(
                "\n"
            ).length
        );
        // The exec bit survives restaging.
        expect(await repo.raw(["ls-tree", "HEAD", "script.sh"])).toMatch(
            /^100755 /
        );
        expect(await repo.raw(["show", "HEAD:ünïcödé/日本語.md"])).toBe(
            "unicode"
        );
        expect(await ourStatus(manager)).toEqual(new Map());
    });

    it("amends the last commit, keeping its author", async () => {
        const repo = withCleanup(await richRepo());
        await repo.raw([
            "commit",
            "--allow-empty",
            "-m",
            "by someone else",
            "--author",
            "Other <other@example.com>",
        ]);
        const parent = await repo.raw(["rev-parse", "HEAD~1"]);
        repo.write("amended.md", "x\n");
        const manager = managerFor(repo);

        await manager.commitAll({ message: "amended", amend: true });
        expect(await repo.raw(["rev-parse", "HEAD~1"])).toBe(parent);
        expect(await repo.raw(["log", "-1", "--format=%an|%cn|%s"])).toBe(
            "Other|Test User|amended"
        );
        expect(await repo.raw(["show", "HEAD:amended.md"])).toBe("x");
        await expectFsckClean(repo);
    });

    it("makes the first commit of an empty repository", async () => {
        const repo = withCleanup(await createEmptyRepo());
        await repo.raw(["config", "user.name", "First"]);
        await repo.raw(["config", "user.email", "first@example.com"]);
        repo.write("first.md", "hello\n");
        repo.write("sub/second.md", "world\n");
        const manager = managerFor(repo);

        expect(await manager.status()).toMatchObject({
            all: [
                { path: "first.md", index: "U", workingDir: "U" },
                { path: "sub/second.md", index: "U", workingDir: "U" },
            ],
        });
        expect(await manager.commitAll({ message: "first" })).toBe(2);
        expect(await repo.raw(["rev-list", "--count", "HEAD"])).toBe("1");
        expect(await repo.statusPorcelain()).toBe("");
        await expectFsckClean(repo);
    });

    it("resolves conflicts by staging and records both merge parents", async () => {
        const repo = withCleanup(await createRepoWithMergeConflict());
        const manager = managerFor(repo);
        expect((await manager.status()).conflicted).toEqual(["note.md"]);

        repo.write("note.md", "resolved\n");
        await manager.stage("note.md", false);
        expect(await repo.raw(["diff", "--name-only", "--diff-filter=U"])).toBe(
            ""
        );
        await manager.commit({ message: "merge" });
        expect(await repo.raw(["log", "-1", "--format=%P"])).toBe(
            `${await repo.raw(["rev-parse", "HEAD~1"])} ${await repo.raw(["rev-parse", "other"])}`
        );
        expect(await manager.isMergeInProgress()).toBe(false);
        await expectFsckClean(repo);
    });

    it("applies concurrent stage requests without losing any", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        const names = Array.from({ length: 12 }, (_, i) => `n${i}.md`);
        for (const n of names) repo.write(n, `${n}\n`);
        const manager = managerFor(repo);

        await Promise.all(names.map((n) => manager.stage(n, false)));
        expect(
            (await repo.raw(["diff", "--cached", "--name-only"])).split("\n")
        ).toEqual([...names].sort());
    });

    it("edits config like git config, keeping the rest of the file", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        const configPath = path.join(repo.repoPath, ".git", "config");
        writeFileSync(
            configPath,
            readFileSync(configPath, "utf8") +
                '# a comment\n[branch "feature/x"]\n\tremote = origin\n'
        );
        const manager = managerFor(repo);

        await manager.setConfig("user.name", "  padded ; name  ");
        await manager.setConfig(
            "branch.feature/x.merge",
            "refs/heads/feature/x"
        );
        await manager.setConfig("new.section.key", 'say "hi"');
        await manager.setConfig("branch.main.remote", undefined);

        expect(await repo.raw(["config", "--get", "user.name"])).toBe(
            "padded ; name"
        );
        expect(
            await repo.raw(["config", "--get", "branch.feature/x.merge"])
        ).toBe("refs/heads/feature/x");
        expect(await repo.raw(["config", "--get", "new.section.key"])).toBe(
            'say "hi"'
        );
        // `git config --get` exits 1 without output for a missing key.
        expect(
            await repo.raw(["config", "--get-all", "branch.main.remote"])
        ).toBe("");
        expect(readFileSync(configPath, "utf8")).toContain("# a comment");
        expect(await manager.getConfig("user.name")).toBe("  padded ; name  ");
    });
});

describe("WasmGit phase 2 review regressions", { timeout: 300_000 }, () => {
    it("replaces a file with a folder without writing a corrupt tree", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        await repo.writeAndCommit("a", "file\n", "a is a file");
        repo.remove("a");
        repo.write("a/b.md", "now a folder\n");
        const manager = managerFor(repo);
        await manager.stage("a/b.md", false);
        await manager.commit({ message: "file to folder" });
        await expectFsckClean(repo);
        expect(await repo.raw(["ls-tree", "-r", "--name-only", "HEAD"])).toBe(
            "a/b.md\nnote.md"
        );
    });

    it("stages resolved conflicts when committing all with a status", async () => {
        const repo = withCleanup(await createRepoWithMergeConflict());
        repo.write("note.md", "resolved\n");
        const manager = managerFor(repo);
        const status = await manager.status();
        await manager.commitAll({
            message: "resolve",
            status,
            unstagedFiles: status.changed,
        });
        expect(await repo.show("HEAD:note.md")).toBe("resolved");
        expect(await repo.raw(["log", "-1", "--format=%P"])).toContain(" ");
    });

    it("does not hide an edit made while the file was being staged", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        repo.write("race.md", "v1\n");
        const { manager, plugin } = createWasmGitManager(repo.repoPath, {
            vaultPath: repo.dir,
            basePath: "worktree",
        });
        const adapter = (
            plugin.app as unknown as {
                vault: {
                    adapter: { readBinary(p: string): Promise<ArrayBuffer> };
                };
            }
        ).vault.adapter;
        const original = adapter.readBinary.bind(adapter);
        let raced = false;
        adapter.readBinary = async (p: string) => {
            const data = await original(p);
            if (!raced && p.endsWith("race.md")) {
                raced = true;
                await new Promise((r) => setTimeout(r, 20));
                repo.write("race.md", "v2 edited mid-stage\n");
            }
            return data;
        };
        await manager.stage("race.md", false);
        expect((await ourStatus(manager)).get("race.md")).toBe("AM");
        expect(await ourStatus(manager)).toEqual(await nativeStatus(repo));
    });

    it("makes no commit when nothing is staged", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        const head = await repo.head();
        const manager = managerFor(repo);
        expect(await manager.commit({ message: "nothing" })).toBe(0);
        expect(await repo.head()).toBe(head);
    });

    it("refuses to amend in the middle of a merge", async () => {
        const repo = withCleanup(await createRepoWithMergeConflict());
        repo.write("note.md", "resolved\n");
        const manager = managerFor(repo);
        await manager.stage("note.md", false);
        await expect(
            manager.commit({ message: "x", amend: true })
        ).rejects.toThrow(/middle of a merge/);
        expect(await manager.isMergeInProgress()).toBe(true);
    });

    it("cleans commit messages like git commit -m", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        const manager = managerFor(repo);
        repo.write("a.md", "a\n");
        await manager.commitAll({ message: "\n\nleading  \n\n\n\nbody\n\n" });
        expect(await repo.git.raw(["cat-file", "commit", "HEAD"])).toMatch(
            /\n\nleading\n\nbody\n$/
        );
        repo.write("b.md", "b\n");
        await expect(manager.commitAll({ message: "  \n " })).rejects.toThrow(
            /empty commit message/
        );
    });

    it("stages the deletion of a whole folder", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        await repo.writeAndCommit("dir/a.md", "a\n", "a");
        await repo.writeAndCommit("dir/sub/b.md", "b\n", "b");
        await repo.raw(["rm", "-q", "-r", "--cached", "dir"]);
        await repo.raw(["reset", "-q"]);
        execFileSync("rm", ["-r", path.join(repo.repoPath, "dir")]);
        const manager = managerFor(repo);
        await manager.stage("dir", false);
        expect(await repo.raw(["diff", "--cached", "--name-status"])).toBe(
            "D\tdir/a.md\nD\tdir/sub/b.md"
        );
    });
});
