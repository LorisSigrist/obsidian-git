import { execFileSync } from "child_process";
import { randomBytes } from "crypto";
import { chmodSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import type { WasmGit } from "../../src/gitManager/wasmGit";
import type { Repository } from "../../src/gitManager/gitcore/repository";
import { withCleanup } from "../helpers/cleanup";
import {
    createEmptyRepo,
    createRepoWithMergeConflict,
    createRepoWithOrigin,
    type TestRepo,
} from "../helpers/gitRepo";
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

describe("WasmGit read-only operations", { timeout: 30_000 }, () => {
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

/** Native git must accept everything we wrote. */
async function expectFsckClean(repo: TestRepo): Promise<void> {
    await expect(
        repo.raw(["fsck", "--full", "--strict", "--no-dangling"])
    ).resolves.toBe("");
}

describe("WasmGit staging and committing", { timeout: 30_000 }, () => {
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

describe("WasmGit phase 1 review regressions", { timeout: 30_000 }, () => {
    it("reads an index written with index.skipHash", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        await repo.raw(["config", "feature.manyFiles", "true"]);
        repo.write("a.md", "a\n");
        await repo.raw(["add", "a.md"]);
        const manager = managerFor(repo);
        expect(await ourStatus(manager)).toEqual(await nativeStatus(repo));
    });

    it("keeps in-flight pack reads working when the pack list refreshes", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        writeFileSync(
            path.join(repo.repoPath, "big.bin"),
            randomBytes(5_000_000)
        );
        await repo.raw(["add", "big.bin"]);
        await repo.git.commit("big");
        await repo.raw(["gc", "--quiet"]);
        const manager = managerFor(repo);
        const r = await repoOf(manager);
        const read = r.readBlobAt("HEAD", "big.bin");
        const missing = r.objects.has("0".repeat(40));
        await expect(missing).resolves.toBe(false);
        expect((await read)!.length).toBe(5_000_000);
    });

    it("does not report files inside submodules or nested repositories", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        // simple-git refuses protocol overrides, so call git directly.
        execFileSync(
            "git",
            [
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                "--quiet",
                repo.remotePath,
                "sub",
            ],
            { cwd: repo.repoPath }
        );
        await repo.git.commit("add submodule");
        await repo.raw(["init", "--quiet", "nested"]);
        repo.write("nested/x.md", "x\n");
        const manager = managerFor(repo);
        const ours = await ourStatus(manager);
        expect([...ours.keys()].filter((p) => p.startsWith("sub/"))).toEqual(
            []
        );
        expect([...ours.keys()].filter((p) => p.startsWith("nested/"))).toEqual(
            []
        );
    });

    it("simplifies file history through merges like git log -- <file>", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        await repo.git.checkoutLocalBranch("side");
        await repo.writeAndCommit("f.md", "side\n", "side change");
        await repo.git.checkout("main");
        await repo.writeAndCommit("other.md", "o\n", "unrelated");
        await repo.raw(["merge", "--no-ff", "-m", "merge", "side"]);
        const manager = managerFor(repo);
        expect((await manager.log("f.md", false)).map((e) => e.hash)).toEqual(
            (await repo.raw(["log", "--format=%H", "--", "f.md"])).split("\n")
        );
    });

    it("resolves a remote name through refs/remotes/<remote>/HEAD", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        await repo.raw(["remote", "set-head", "origin", "main"]);
        const manager = managerFor(repo);
        expect(await manager.resolveRef("origin")).toBe(
            await repo.raw(["rev-parse", "origin"])
        );
    });

    it("does not continue comment lines in config", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        const configPath = path.join(repo.repoPath, ".git", "config");
        const text = readFileSync(configPath, "utf8").replace(
            '[remote "origin"]',
            '# trailing \\\n[remote "origin"]'
        );
        writeFileSync(configPath, text);
        const manager = managerFor(repo);
        expect(await manager.getRemotes()).toEqual(["origin"]);
        expect(await manager.getRemoteUrl("origin")).toBe(repo.remotePath);
    });

    it("matches ignore patterns case-sensitively unless core.ignorecase is set", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        await repo.raw(["config", "core.ignorecase", "false"]);
        await repo.writeAndCommit(".gitignore", "*.MD\n", "ignore");
        repo.write("x.md", "x\n");
        const manager = managerFor(repo);
        expect(await ourStatus(manager)).toEqual(await nativeStatus(repo));
        await repo.raw(["config", "core.ignorecase", "true"]);
        expect((await ourStatus(manager)).has("x.md")).toBe(false);
    });

    it("prints UTC commit dates like git", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        await repo.raw([
            "commit",
            "--allow-empty",
            "-m",
            "utc",
            "--date",
            "2020-01-01T00:00:00+0000",
        ]);
        const manager = managerFor(repo);
        expect((await manager.log(undefined, true, 1))[0]!.date).toBe(
            await repo.raw(["log", "-1", "--format=%aI"])
        );
    });
});

describe("WasmGit branches and remotes", { timeout: 30_000 }, () => {
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
