import path from "path";
import { execFileSync } from "child_process";
import { randomBytes } from "crypto";
import { readFileSync, writeFileSync } from "fs";
import { withCleanup } from "../helpers/cleanup";
import { createRepoWithOrigin } from "../helpers/gitRepo";
import {
    managerFor,
    repoOf,
    nativeStatus,
    ourStatus,
    richRepo,
    makeChanges,
} from "../helpers/wasmGitFixtures";
import { describe, expect, it } from "vitest";

describe("WasmGit read-only operations", { timeout: 300_000 }, () => {
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

describe("WasmGit phase 1 review regressions", { timeout: 300_000 }, () => {
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
