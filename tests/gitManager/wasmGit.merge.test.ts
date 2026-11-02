import path from "path";
import { execFileSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
import { mergeText } from "../../src/gitManager/gitcore/merge";
import { GitConflictError } from "../../src/types";
import { withCleanup } from "../helpers/cleanup";
import { nodeHttp, startGitHttpServer } from "../helpers/gitHttpServer";
import { createRepoWithOrigin, type TestRepo } from "../helpers/gitRepo";
import { createWasmGitManager } from "../helpers/wasmGit";
import {
    nativeStatus,
    ourStatus,
    expectFsckClean,
} from "../helpers/wasmGitFixtures";
import { describe, expect, it } from "vitest";

describe("WasmGit pull and merge", { timeout: 300_000 }, () => {
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

describe("WasmGit phase 5 review regressions", { timeout: 300_000 }, () => {
    function puller(repo: TestRepo) {
        const ctx = createWasmGitManager(repo.repoPath);
        ctx.manager.fetch = () => Promise.resolve();
        return ctx;
    }
    /** Diverge: run `ours` on main and `theirs` on a branch from the same base. */
    async function diverge(
        repo: TestRepo,
        ours: () => Promise<void>,
        theirs: () => Promise<void>
    ) {
        await repo.git.checkoutLocalBranch("theirs");
        await theirs();
        const theirCommit = await repo.head();
        await repo.git.checkout("main");
        await ours();
        await repo.raw(["update-ref", "refs/remotes/origin/main", theirCommit]);
    }
    const snapshot = async (repo: TestRepo) =>
        `${await repo.head()}\n${await repo.git.raw(["status", "--porcelain", "-uall"])}\n${await repo.raw(["ls-files", "-s"])}`;

    it("refuses file-vs-folder conflicts without touching the vault", async () => {
        for (const [ours, theirs] of [
            ["x", "x/a.md"],
            ["x/a.md", "x"],
        ] as const) {
            const repo = withCleanup(await createRepoWithOrigin());
            await diverge(
                repo,
                () => repo.writeAndCommit(ours, "ours\n", "ours"),
                () => repo.writeAndCommit(theirs, "theirs\n", "theirs")
            );
            const before = await snapshot(repo);
            await expect(puller(repo).manager.pull()).rejects.toThrow(
                /file on one side and a folder/
            );
            expect(await snapshot(repo)).toBe(before);
            expect(readFileSync(path.join(repo.repoPath, ours), "utf8")).toBe(
                "ours\n"
            );
        }
    });

    it("refuses when a folder replaces a file we modified", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        await repo.writeAndCommit("topic", "base\n", "topic file");
        await diverge(
            repo,
            () => repo.writeAndCommit("topic", "ours\n", "we edit"),
            async () => {
                await repo.git.rm("topic");
                await repo.writeAndCommit("topic/a.md", "a\n", "folder");
            }
        );
        const before = await snapshot(repo);
        await expect(puller(repo).manager.pull()).rejects.toThrow(/folder/);
        expect(await snapshot(repo)).toBe(before);
    });

    it("refuses criss-cross merges and unrelated histories", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        await repo.writeAndCommit("n.md", "a\nX\nb\n", "base");
        await repo.git.checkoutLocalBranch("B");
        await repo.writeAndCommit("n.md", "a\nTWO\nb\n", "two");
        await repo.git.checkout("main");
        await repo.writeAndCommit("n.md", "a\nONE\nb\n", "one");
        const a1 = await repo.head();
        await repo.raw(["merge", "-q", "-s", "ours", "-m", "A takes B", "B"]);
        await repo.git.checkout("B");
        await repo.raw(["merge", "-q", "-s", "ours", "-m", "B takes A", a1]);
        await repo.writeAndCommit("other.md", "o\n", "more B");
        const b = await repo.head();
        await repo.git.checkout("main");
        await repo.raw(["update-ref", "refs/remotes/origin/main", b]);
        await expect(puller(repo).manager.pull()).rejects.toThrow(
            /merge bases/
        );
        expect(readFileSync(path.join(repo.repoPath, "n.md"), "utf8")).toBe(
            "a\nONE\nb\n"
        );

        const unrelated = withCleanup(await createRepoWithOrigin());
        const orphan = execFileSync(
            "sh",
            [
                "-c",
                "git checkout -q --orphan lonely && echo x > lonely.md && git add -A && git commit -qm lonely && git rev-parse HEAD && git checkout -q -f main",
            ],
            { cwd: unrelated.repoPath, encoding: "utf8" }
        ).trim();
        await unrelated.raw(["update-ref", "refs/remotes/origin/main", orphan]);
        await expect(puller(unrelated).manager.pull()).rejects.toThrow(
            /unrelated histories/
        );
    });

    it("keeps every byte in clean text merges", () => {
        const labels = { ours: "HEAD", theirs: "theirs" };
        for (const special of ["mid dle", "old\rmac", "line\r\r\n", "﻿bom"]) {
            // Edits far enough apart not to touch, as in git merge-file.
            const base = `${special}\nx\nk1\nk2\ny\n`;
            const ours = `${special}\nX\nk1\nk2\ny\n`;
            const theirs = `${special}\nx\nk1\nk2\nY\n`;
            expect(mergeText(base, ours, theirs, "none", labels)).toEqual({
                clean: true,
                text: `${special}\nX\nk1\nk2\nY\n`,
            });
        }
    });

    it("treats files that are not UTF-8 as binary when merging", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        const latin1 = (s: string) => Buffer.from(s, "latin1");
        writeFileSync(
            path.join(repo.repoPath, "l.txt"),
            latin1("caf\xe9\nx\ny\n")
        );
        await repo.raw(["add", "l.txt"]);
        await repo.git.commit("latin1");
        await diverge(
            repo,
            async () => {
                writeFileSync(
                    path.join(repo.repoPath, "l.txt"),
                    latin1("caf\xe9\nX\ny\n")
                );
                await repo.raw(["commit", "-qam", "ours"]);
            },
            async () => {
                writeFileSync(
                    path.join(repo.repoPath, "l.txt"),
                    latin1("caf\xe9\nx\nY\n")
                );
                await repo.raw(["commit", "-qam", "theirs"]);
            }
        );
        await expect(puller(repo).manager.pull()).rejects.toBeInstanceOf(
            GitConflictError
        );
        expect([...readFileSync(path.join(repo.repoPath, "l.txt"))]).toEqual([
            ...latin1("caf\xe9\nX\ny\n"),
        ]);
    });
});
