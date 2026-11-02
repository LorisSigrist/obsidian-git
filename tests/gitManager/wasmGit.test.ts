import { execFileSync } from "child_process";
import { randomBytes } from "crypto";
import { chmodSync, readdirSync, readFileSync, writeFileSync } from "fs";
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
import { GitConflictError } from "../../src/types";
import { nodeHttp, startGitHttpServer } from "../helpers/gitHttpServer";
import { fetchRemote } from "../../src/gitManager/gitcore/remote";
import { parseRemoteUrl } from "../../src/gitManager/gitcore/transport";
import {
    PushRejectedError,
    UserCanceledError,
} from "../../src/gitManager/gitcore/errors";

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

describe("WasmGit phase 2 review regressions", { timeout: 30_000 }, () => {
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

describe("WasmGit fetch and push over smart HTTP", { timeout: 60_000 }, () => {
    async function served(auth?: { username: string; password: string }) {
        const repo = withCleanup(await createRepoWithOrigin());
        const server = await startGitHttpServer(repo.dir, auth);
        await repo.raw([
            "remote",
            "set-url",
            "origin",
            server.url("remote.git"),
        ]);
        const ctx = createWasmGitManager(repo.repoPath, {
            vaultPath: repo.dir,
            basePath: "worktree",
        });
        ctx.manager.http = nodeHttp;
        ctx.plugin.settings.disablePopups = true;
        ctx.plugin.localStorage = {
            ...ctx.plugin.localStorage,
            getUsername: () => auth?.username ?? null,
        } as unknown as typeof ctx.plugin.localStorage;
        (
            ctx.plugin as unknown as { gitServerPassword: unknown }
        ).gitServerPassword = {
            get: () => auth?.password ?? null,
            set: async () => {},
        };
        /** A second clone that pushes to the remote over the filesystem. */
        const other = path.join(repo.dir, "other");
        await repo.raw(["clone", "--quiet", repo.remotePath, other]);
        const otherGit = (...args: string[]) =>
            execFileSync("git", args, { cwd: other, encoding: "utf8" }).trim();
        otherGit("config", "user.name", "Other");
        otherGit("config", "user.email", "other@example.com");
        return { repo, server, other, otherGit, ...ctx };
    }

    it("fetches new commits, packs and deltas into the remote-tracking ref", async () => {
        const { repo, server, other, otherGit, manager } = await served();
        try {
            const big = randomBytes(2_500_000);
            writeFileSync(path.join(other, "big.bin"), big);
            writeFileSync(path.join(other, "remote.md"), "remote\n");
            otherGit("add", ".");
            otherGit("commit", "-qm", "remote work");
            big[100] = big[100]! ^ 1;
            writeFileSync(path.join(other, "big.bin"), big);
            otherGit("commit", "-qam", "remote edit");
            otherGit("push", "-q", "origin", "main");

            await manager.fetch();
            expect(await repo.raw(["rev-parse", "origin/main"])).toBe(
                otherGit("rev-parse", "HEAD")
            );
            expect(await repo.raw(["show", "origin/main:remote.md"])).toBe(
                "remote"
            );
            await expectFsckClean(repo);
            // Nothing new: no pack is requested.
            const before = server.requests.length;
            await manager.fetch();
            expect(server.requests.slice(before)).toEqual([
                "GET /remote.git/info/refs",
            ]);
            // The fetched objects are readable through our own pack reader.
            expect(await manager.show("origin/main", "remote.md", false)).toBe(
                "remote\n"
            );
        } finally {
            await server.close();
        }
    });

    it("pushes the current branch and reports up to date afterwards", async () => {
        const { repo, server, manager } = await served();
        try {
            await repo.writeAndCommit("a.md", "a\n", "local a");
            writeFileSync(
                path.join(repo.repoPath, "pic.bin"),
                randomBytes(300_000)
            );
            await repo.raw(["add", "pic.bin"]);
            await repo.git.commit("local pic");

            await expect(manager.push()).resolves.toEqual({
                status: "pushed",
                files: 2,
            });
            expect(
                execFileSync("git", ["rev-parse", "main"], {
                    cwd: repo.remotePath,
                    encoding: "utf8",
                }).trim()
            ).toBe(await repo.head());
            expect(await repo.raw(["rev-parse", "origin/main"])).toBe(
                await repo.head()
            );
            execFileSync("git", ["fsck", "--strict"], { cwd: repo.remotePath });
            await expect(manager.push()).resolves.toEqual({
                status: "up-to-date",
            });
        } finally {
            await server.close();
        }
    });

    it("rejects a push that is not a fast-forward", async () => {
        const { repo, server, other, otherGit, manager } = await served();
        try {
            writeFileSync(path.join(other, "theirs.md"), "theirs\n");
            otherGit("add", ".");
            otherGit("commit", "-qm", "theirs");
            otherGit("push", "-q", "origin", "main");
            await repo.writeAndCommit("mine.md", "mine\n", "mine");

            await expect(manager.push()).rejects.toBeInstanceOf(
                PushRejectedError
            );
            await manager.fetch();
            await expect(manager.push()).rejects.toMatchObject({
                reason: "not-fast-forward",
            });
        } finally {
            await server.close();
        }
    });

    it("pushes a new branch when setting its upstream", async () => {
        const { repo, server, manager } = await served();
        try {
            await repo.raw(["checkout", "-q", "-b", "topic"]);
            await repo.writeAndCommit("t.md", "t\n", "topic work");
            await manager.updateUpstreamBranch("origin/topic");
            expect(
                execFileSync("git", ["rev-parse", "topic"], {
                    cwd: repo.remotePath,
                    encoding: "utf8",
                }).trim()
            ).toBe(await repo.head());
            expect(
                await repo.raw([
                    "rev-parse",
                    "--abbrev-ref",
                    "topic@{upstream}",
                ])
            ).toBe("origin/topic");
        } finally {
            await server.close();
        }
    });

    it("authenticates with stored credentials and asks again on failure", async () => {
        const { repo, server, manager } = await served({
            username: "me",
            password: "s3cret",
        });
        try {
            await repo.writeAndCommit("a.md", "a\n", "a");
            await expect(manager.push()).resolves.toMatchObject({
                status: "pushed",
            });
            await manager.fetch();

            // Wrong credentials and the user cancels the prompt.
            const r = await repoOf(manager);
            await expect(
                fetchRemote(r, {
                    url: server.url("remote.git"),
                    http: nodeHttp,
                    remote: "origin",
                    refspecs: ["+refs/heads/*:refs/remotes/origin/*"],
                    auth: {
                        onAuth: () => ({ username: "me", password: "wrong" }),
                        onAuthFailure: () =>
                            Promise.resolve({ cancel: true as const }),
                    },
                })
            ).rejects.toBeInstanceOf(UserCanceledError);

            // Credentials in the URL are used as Basic auth.
            const withCreds = server
                .url("remote.git")
                .replace("http://", "http://me:s3cret@");
            await expect(
                fetchRemote(r, {
                    url: withCreds,
                    http: nodeHttp,
                    remote: "origin",
                    refspecs: ["+refs/heads/*:refs/remotes/origin/*"],
                })
            ).resolves.toBeDefined();
        } finally {
            await server.close();
        }
    });

    it("fetches a shallow history with a depth", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        for (let i = 0; i < 5; i++) {
            await repo.appendAndCommit("note.md", `${i}\n`, `c${i}`);
        }
        await repo.git.push(["--quiet"]);
        const server = await startGitHttpServer(repo.dir);
        try {
            const fresh = path.join(repo.dir, "fresh");
            execFileSync("git", ["init", "-q", "-b", "main", fresh]);
            const { manager } = createWasmGitManager(fresh, {
                vaultPath: repo.dir,
                basePath: "fresh",
            });
            const r = await repoOf(manager);
            await fetchRemote(r, {
                url: server.url("remote.git"),
                http: nodeHttp,
                remote: "origin",
                refspecs: ["+refs/heads/*:refs/remotes/origin/*"],
                depth: 2,
            });
            const log = execFileSync(
                "git",
                ["log", "--format=%s", "refs/remotes/origin/main"],
                { cwd: fresh, encoding: "utf8" }
            ).trim();
            expect(log).toBe("c4\nc3");
            expect(
                readFileSync(path.join(fresh, ".git", "shallow"), "utf8").trim()
            ).toHaveLength(40);
            execFileSync("git", ["fsck", "--strict", "--no-dangling"], {
                cwd: fresh,
            });
        } finally {
            await server.close();
        }
    });
});

describe("WasmGit phase 3 review regressions", { timeout: 30_000 }, () => {
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

describe("WasmGit pull and merge", { timeout: 30_000 }, () => {
    /** A manager whose fetch is a no-op (refs/remotes/origin/main is set by the test). */
    function puller(repo: TestRepo) {
        const ctx = createWasmGitManager(repo.repoPath);
        ctx.manager.fetch = () => Promise.resolve();
        return ctx;
    }
    const readF = (repo: TestRepo, p: string) =>
        readFileSync(path.join(repo.repoPath, p), "utf8");
    const gone = (repo: TestRepo, p: string) => {
        try {
            readFileSync(path.join(repo.repoPath, p));
            return false;
        } catch {
            return true;
        }
    };

    it("leaves HEAD and the worktree alone when a fast-forward overlaps a local edit", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        const settingsFile = ".obsidian/plugins/obsidian-git/data.json";
        await repo.writeAndCommit(
            ".gitignore",
            ".obsidian/plugins/**\n!.obsidian/plugins/*/\n!.obsidian/plugins/*/data.json\n",
            "ignore plugin code"
        );
        await repo.writeAndCommit(settingsFile, '{"a":1}\n', "settings");
        const oldHead = await repo.head();
        await repo.writeAndCommit(
            settingsFile,
            '{"a":1,"remote":true}\n',
            "remote change"
        );
        await repo.writeAndCommit("new.md", "new\n", "remote addition");
        await repo.raw([
            "update-ref",
            "refs/remotes/origin/main",
            await repo.head(),
        ]);
        await repo.raw(["reset", "--hard", oldHead]);
        repo.write(settingsFile, '{"a":1,"local":true}\n');
        const { manager } = puller(repo);

        await expect(manager.pull()).rejects.toThrow(/uncommitted/);
        expect(await repo.head()).toBe(oldHead);
        expect(readF(repo, settingsFile)).toBe('{"a":1,"local":true}\n');
        expect(gone(repo, "new.md")).toBe(true);

        await repo.git.add(settingsFile);
        await expect(manager.pull()).rejects.toThrow(/uncommitted/);
        expect(await repo.head()).toBe(oldHead);
        expect(await repo.cachedDiffNames()).toBe(settingsFile);
        await manager.commitAll({ message: "automatic backup" });
        expect(await repo.raw(["rev-parse", "HEAD^"])).toBe(oldHead);
    });

    it("preserves unrelated staged and unstaged changes during a fast-forward", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        await repo.writeAndCommit("staged.md", "base\n", "staged file");
        await repo.writeAndCommit("unstaged.md", "base\n", "unstaged file");
        const oldHead = await repo.head();
        await repo.writeAndCommit("note.md", "remote\n", "remote change");
        const remoteHead = await repo.head();
        await repo.raw(["update-ref", "refs/remotes/origin/main", remoteHead]);
        await repo.raw(["reset", "--hard", oldHead]);
        repo.write("staged.md", "local staged\n");
        await repo.git.add("staged.md");
        repo.write("unstaged.md", "local unstaged\n");
        const { manager } = puller(repo);

        await expect(manager.pull()).resolves.toMatchObject({
            status: "updated",
            files: [{ path: "note.md" }],
        });
        expect(await repo.head()).toBe(remoteHead);
        expect(readF(repo, "note.md")).toBe("remote\n");
        expect(readF(repo, "staged.md")).toBe("local staged\n");
        expect(readF(repo, "unstaged.md")).toBe("local unstaged\n");
        expect(await repo.cachedDiffNames()).toBe("staged.md");
        expect(await ourStatus(manager)).toEqual(await nativeStatus(repo));
    });

    it("reports up to date with a dirty worktree when the local branch is ahead", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        await repo.writeAndCommit("local.md", "local\n", "local commit");
        const localHead = await repo.head();
        repo.write("note.md", "uncommitted\n");
        const { manager } = puller(repo);
        await expect(manager.pull()).resolves.toEqual({ status: "up-to-date" });
        expect(await repo.head()).toBe(localHead);
        expect(readF(repo, "note.md")).toBe("uncommitted\n");
    });

    it("creates a merge commit with no tree changes without requiring a clean worktree", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        const oldHead = await repo.head();
        await repo.raw([
            "commit",
            "--allow-empty",
            "-m",
            "empty remote commit",
        ]);
        const remoteHead = await repo.head();
        await repo.raw(["update-ref", "refs/remotes/origin/main", remoteHead]);
        await repo.raw(["reset", "--hard", oldHead]);
        await repo.raw(["commit", "--allow-empty", "-m", "empty local commit"]);
        const localHead = await repo.head();
        repo.write("note.md", "local uncommitted\n");
        const { manager } = puller(repo);

        await expect(manager.pull()).resolves.toMatchObject({
            status: "updated",
            files: [],
        });
        expect(await repo.raw(["log", "-1", "--format=%P"])).toBe(
            `${localHead} ${remoteHead}`
        );
        expect(await repo.raw(["log", "-1", "--format=%s"])).toBe(
            "Merge branch 'origin/main' into main"
        );
        expect(readF(repo, "note.md")).toBe("local uncommitted\n");
        await expectFsckClean(repo);
    });

    it("catches an affected file edited while the pull is in progress", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        const oldHead = await repo.head();
        await repo.writeAndCommit("note.md", "remote\n", "remote change");
        await repo.raw([
            "update-ref",
            "refs/remotes/origin/main",
            await repo.head(),
        ]);
        await repo.raw(["reset", "--hard", oldHead]);
        const { manager } = puller(repo);
        manager.fetch = () => {
            repo.write("note.md", "edited during pull\n");
            return Promise.resolve();
        };
        await expect(manager.pull()).rejects.toThrow(/uncommitted/);
        expect(await repo.head()).toBe(oldHead);
        expect(readF(repo, "note.md")).toBe("edited during pull\n");
    });

    it("does not overwrite an ignored untracked file added by the remote", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        const incoming = ".obsidian/plugins/new-plugin/data.json";
        await repo.writeAndCommit(
            ".gitignore",
            ".obsidian/plugins/**\n",
            "ignore plugin data"
        );
        const oldHead = await repo.head();
        repo.write(incoming, "remote\n");
        await repo.git.add(["-f", incoming]);
        await repo.git.commit("remote addition");
        await repo.raw([
            "update-ref",
            "refs/remotes/origin/main",
            await repo.head(),
        ]);
        await repo.raw(["reset", "--hard", oldHead]);
        repo.write(incoming, "local\n");
        const { manager } = puller(repo);
        await expect(manager.pull()).rejects.toThrow(/untracked file/);
        expect(await repo.head()).toBe(oldHead);
        expect(readF(repo, incoming)).toBe("local\n");
    });

    it("does not advance HEAD if writing the working tree fails", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        const oldHead = await repo.head();
        await repo.writeAndCommit("remote.md", "remote\n", "remote change");
        await repo.raw([
            "update-ref",
            "refs/remotes/origin/main",
            await repo.head(),
        ]);
        await repo.raw(["reset", "--hard", oldHead]);
        const { manager, plugin } = puller(repo);
        const vault = (
            plugin.app as unknown as {
                vault: {
                    createBinary: (p: string, d: ArrayBuffer) => Promise<void>;
                };
            }
        ).vault;
        vault.createBinary = () => Promise.reject(new Error("disk full"));
        await expect(manager.pull()).rejects.toThrow("disk full");
        expect(await repo.head()).toBe(oldHead);
    });

    it("merges diverged histories, touching only changed paths", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        await repo.writeAndCommit("note.md", "a\nb\nc\nd\ne\nf\n", "six lines");
        await repo.writeAndCommit("old.md", "old\n", "old file");
        await repo.writeAndCommit("staged.md", "base\n", "staged file");
        await repo.writeAndCommit("unstaged.md", "base\n", "unstaged file");
        const base = await repo.head();
        await repo.writeAndCommit(
            "note.md",
            "REMOTE\nb\nc\nd\ne\nf\n",
            "remote change"
        );
        await repo.writeAndCommit("new.md", "new\n", "remote addition");
        await repo.git.rm("old.md");
        await repo.git.commit("remote deletion");
        await repo.raw([
            "update-ref",
            "refs/remotes/origin/main",
            await repo.head(),
        ]);
        await repo.raw(["reset", "--hard", base]);
        await repo.writeAndCommit(
            "note.md",
            "a\nb\nc\nd\ne\nLOCAL\n",
            "local change"
        );
        repo.write("staged.md", "local staged\n");
        await repo.git.add("staged.md");
        repo.write("unstaged.md", "local unstaged\n");
        const { manager } = puller(repo);

        const result = await manager.pull();
        expect(result).toMatchObject({ status: "updated" });
        expect(
            new Set(
                (result as { files: { path: string }[] }).files.map(
                    (f) => f.path
                )
            )
        ).toEqual(new Set(["note.md", "new.md", "old.md"]));
        expect(readF(repo, "note.md")).toBe("REMOTE\nb\nc\nd\ne\nLOCAL\n");
        expect(await repo.show("HEAD:note.md")).toBe(
            "REMOTE\nb\nc\nd\ne\nLOCAL"
        );
        expect(readF(repo, "new.md")).toBe("new\n");
        expect(gone(repo, "old.md")).toBe(true);
        expect(readF(repo, "staged.md")).toBe("local staged\n");
        expect(readF(repo, "unstaged.md")).toBe("local unstaged\n");
        expect(await repo.cachedDiffNames()).toBe("staged.md");
        await expectFsckClean(repo);
    });

    it("rejects an uncommitted change to a file affected by a real merge", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        await repo.writeAndCommit("note.md", "a\nb\nc\nd\ne\nf\n", "six lines");
        const base = await repo.head();
        await repo.writeAndCommit(
            "note.md",
            "REMOTE\nb\nc\nd\ne\nf\n",
            "remote change"
        );
        await repo.raw([
            "update-ref",
            "refs/remotes/origin/main",
            await repo.head(),
        ]);
        await repo.raw(["reset", "--hard", base]);
        await repo.writeAndCommit(
            "note.md",
            "a\nb\nc\nd\ne\nLOCAL\n",
            "local change"
        );
        const localHead = await repo.head();
        repo.write("note.md", "local uncommitted edit\n");
        const { manager } = puller(repo);
        await expect(manager.pull()).rejects.toThrow(/uncommitted/);
        expect(await repo.head()).toBe(localHead);
        expect(readF(repo, "note.md")).toBe("local uncommitted edit\n");
    });

    it("writes conflict markers, index stages and merge metadata for a conflict", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        await repo.writeAndCommit("unrelated.md", "base\n", "unrelated file");
        await repo.git.checkoutLocalBranch("theirs");
        await repo.writeAndCommit("note.md", "theirs\n", "their change");
        await repo.writeAndCommit("both.md", "added by them\n", "their add");
        const theirCommit = await repo.head();
        await repo.git.checkout("main");
        await repo.writeAndCommit("note.md", "ours\n", "our change");
        const localCommit = await repo.head();
        await repo.raw(["update-ref", "refs/remotes/origin/main", theirCommit]);
        repo.write("unrelated.md", "local uncommitted\n");
        const { manager, plugin } = puller(repo);

        await expect(manager.pull()).rejects.toThrow(/uncommitted/);
        expect(await repo.head()).toBe(localCommit);
        expect(readF(repo, "note.md")).toBe("ours\n");
        expect(await manager.isMergeInProgress()).toBe(false);

        repo.write("unrelated.md", "base\n");
        await expect(manager.pull()).rejects.toBeInstanceOf(GitConflictError);
        const content = readF(repo, "note.md");
        expect(content).toMatch(
            /<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> origin\/main\n/
        );
        expect(readF(repo, "both.md")).toBe("added by them\n");
        expect((await manager.status()).conflicted).toEqual(["note.md"]);
        // Native git sees the same unmerged state.
        expect(await repo.raw(["ls-files", "-u", "--", "note.md"])).toMatch(
            /1\tnote\.md\n.* 2\tnote\.md\n.* 3\tnote\.md/
        );
        expect(readF(repo, ".git/ORIG_HEAD")).toBe(`${localCommit}\n`);
        expect(readF(repo, ".git/MERGE_HEAD")).toBe(`${theirCommit}\n`);
        expect(readF(repo, ".git/MERGE_MSG")).toBe(
            "Merge branch 'origin/main' into main\n"
        );
        expect(plugin.displayError).not.toHaveBeenCalled();

        // Resolving and committing finishes the merge.
        repo.write("note.md", "resolved\n");
        await manager.commitAll({ message: "resolve" });
        expect(await repo.raw(["log", "-1", "--format=%P"])).toBe(
            `${localCommit} ${theirCommit}`
        );
        await expectFsckClean(repo);
    });

    it("resolves conflicting hunks with the ours/theirs strategies", async () => {
        for (const strategy of ["ours", "theirs"] as const) {
            const repo = withCleanup(await createRepoWithOrigin());
            await repo.writeAndCommit("note.md", "1\n2\n3\n", "base");
            await repo.git.checkoutLocalBranch("theirs");
            await repo.writeAndCommit("note.md", "1\nTHEIRS\n3\n", "theirs");
            const theirCommit = await repo.head();
            await repo.git.checkout("main");
            await repo.writeAndCommit("note.md", "1\nOURS\n3\n", "ours");
            await repo.raw([
                "update-ref",
                "refs/remotes/origin/main",
                theirCommit,
            ]);
            const { manager, plugin } = puller(repo);
            plugin.settings.mergeStrategy = strategy;
            await expect(manager.pull()).resolves.toMatchObject({
                status: "updated",
            });
            expect(readF(repo, "note.md")).toBe(
                strategy === "ours" ? "1\nOURS\n3\n" : "1\nTHEIRS\n3\n"
            );
            expect(await repo.statusPorcelain()).toBe("");
        }
    });

    it("reports delete/modify and binary conflicts", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        await repo.writeAndCommit("gone.md", "base\n", "base gone");
        writeFileSync(
            path.join(repo.repoPath, "img.bin"),
            Buffer.from([0, 1, 2])
        );
        await repo.raw(["add", "img.bin"]);
        await repo.git.commit("img");
        await repo.git.checkoutLocalBranch("theirs");
        await repo.writeAndCommit("gone.md", "they edited\n", "edit");
        writeFileSync(
            path.join(repo.repoPath, "img.bin"),
            Buffer.from([0, 9, 9])
        );
        await repo.raw(["commit", "-qam", "their img"]);
        const theirCommit = await repo.head();
        await repo.git.checkout("main");
        await repo.git.rm("gone.md");
        writeFileSync(
            path.join(repo.repoPath, "img.bin"),
            Buffer.from([0, 7, 7])
        );
        await repo.raw(["commit", "-qam", "we delete and change img"]);
        await repo.raw(["update-ref", "refs/remotes/origin/main", theirCommit]);
        const { manager } = puller(repo);

        await expect(manager.pull()).rejects.toMatchObject({
            files: ["gone.md", "img.bin"],
        });
        expect(readF(repo, "gone.md")).toBe("they edited\n");
        expect([...readFileSync(path.join(repo.repoPath, "img.bin"))]).toEqual([
            0, 7, 7,
        ]);
        expect((await manager.status()).conflicted).toEqual([
            "gone.md",
            "img.bin",
        ]);
    });

    it("pulls over HTTP end to end", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        const server = await startGitHttpServer(repo.dir);
        try {
            await repo.raw([
                "remote",
                "set-url",
                "origin",
                server.url("remote.git"),
            ]);
            const other = path.join(repo.dir, "other");
            await repo.raw(["clone", "--quiet", repo.remotePath, other]);
            writeFileSync(path.join(other, "from-other.md"), "hello\n");
            execFileSync("git", ["add", "."], { cwd: other });
            execFileSync(
                "git",
                [
                    "-c",
                    "user.name=O",
                    "-c",
                    "user.email=o@x",
                    "commit",
                    "-qm",
                    "other",
                ],
                { cwd: other }
            );
            execFileSync("git", ["push", "-q", "origin", "main"], {
                cwd: other,
            });
            await repo.writeAndCommit("mine.md", "mine\n", "mine");
            const ctx = createWasmGitManager(repo.repoPath);
            ctx.manager.http = nodeHttp;
            ctx.plugin.settings.disablePopups = true;

            await expect(ctx.manager.pull()).resolves.toMatchObject({
                status: "updated",
                files: [{ path: "from-other.md" }],
            });
            expect(readF(repo, "from-other.md")).toBe("hello\n");
            await expect(ctx.manager.push()).resolves.toMatchObject({
                status: "pushed",
            });
            await expectFsckClean(repo);
        } finally {
            await server.close();
        }
    });
});

describe("WasmGit phase 4 review regressions", { timeout: 60_000 }, () => {
    it("fetches only new objects after many unpushed local commits", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        for (let i = 0; i < 20; i++) {
            await repo.appendAndCommit("note.md", `${i}\n`, `history ${i}`);
        }
        await repo.git.push(["--quiet"]);
        // 300 local commits that are not pushed, made in one fast-import.
        const head = await repo.head();
        let stream = "";
        for (let i = 0; i < 300; i++) {
            const msg = `local${i}`;
            stream +=
                `commit refs/heads/main\n` +
                `committer L <l@x> ${1_900_000_000 + i} +0000\n` +
                `data ${msg.length}\n${msg}\n` +
                (i === 0 ? `from ${head}\n` : "") +
                "\n";
        }
        execFileSync("git", ["fast-import", "--quiet", "--force"], {
            cwd: repo.repoPath,
            input: stream,
        });
        // One new remote commit with one new file.
        const other = path.join(repo.dir, "other");
        execFileSync("git", ["clone", "-q", repo.remotePath, other]);
        writeFileSync(path.join(other, "new.md"), "new\n");
        execFileSync("git", ["add", "."], { cwd: other });
        execFileSync(
            "git",
            [
                "-c",
                "user.name=O",
                "-c",
                "user.email=o@x",
                "commit",
                "-qm",
                "remote",
            ],
            { cwd: other }
        );
        execFileSync("git", ["push", "-q", "origin", "main"], { cwd: other });

        const server = await startGitHttpServer(repo.dir);
        try {
            const r = await repoOf(managerFor(repo));
            await repo.raw(["gc", "--quiet"]);
            const packDir = path.join(repo.repoPath, ".git", "objects", "pack");
            const before = new Set(readdirSync(packDir));
            await fetchRemote(r, {
                url: server.url("remote.git"),
                http: nodeHttp,
                remote: "origin",
                refspecs: ["+refs/heads/*:refs/remotes/origin/*"],
            });
            const added = readdirSync(packDir).filter(
                (f) => f.endsWith(".idx") && !before.has(f)
            );
            expect(added).toHaveLength(1);
            const objects = execFileSync("git", ["show-index"], {
                input: readFileSync(path.join(packDir, added[0]!)),
                encoding: "utf8",
            })
                .trim()
                .split("\n");
            // The commit, its tree and the new blob.
            expect(objects).toHaveLength(3);
        } finally {
            await server.close();
        }
    });

    it("keeps everything after the first colon as the password", () => {
        expect(parseRemoteUrl("https://user:pa:ss@host/x.git")).toEqual({
            url: "https://host/x.git",
            credentials: { username: "user", password: "pa:ss" },
        });
    });

    it("pushes a complete set of objects across merges and long history", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        const server = await startGitHttpServer(repo.dir);
        try {
            await repo.raw([
                "remote",
                "set-url",
                "origin",
                server.url("remote.git"),
            ]);
            for (let i = 0; i < 40; i++) {
                await repo.appendAndCommit("note.md", `${i}\n`, `c${i}`);
            }
            await repo.raw(["checkout", "-q", "-b", "side", "HEAD~20"]);
            await repo.writeAndCommit("side/s.md", "side\n", "side work");
            await repo.raw(["checkout", "-q", "main"]);
            await repo.raw([
                "merge",
                "-q",
                "--no-ff",
                "-m",
                "merge side",
                "side",
            ]);
            const ctx = createWasmGitManager(repo.repoPath);
            ctx.manager.http = nodeHttp;
            ctx.plugin.settings.disablePopups = true;
            await expect(ctx.manager.push()).resolves.toMatchObject({
                status: "pushed",
            });
            execFileSync("git", ["fsck", "--strict", "--no-dangling"], {
                cwd: repo.remotePath,
            });
            expect(
                execFileSync("git", ["rev-parse", "main"], {
                    cwd: repo.remotePath,
                    encoding: "utf8",
                }).trim()
            ).toBe(await repo.head());
        } finally {
            await server.close();
        }
    });
});
