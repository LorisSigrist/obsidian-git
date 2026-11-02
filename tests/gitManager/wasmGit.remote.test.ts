import path from "path";
import { execFileSync } from "child_process";
import { randomBytes } from "crypto";
import { readdirSync, readFileSync, writeFileSync } from "fs";
import {
    PushRejectedError,
    UserCanceledError,
} from "../../src/gitManager/gitcore/errors";
import { fetchRemote } from "../../src/gitManager/gitcore/remote";
import { parseRemoteUrl } from "../../src/gitManager/gitcore/transport";
import { withCleanup } from "../helpers/cleanup";
import { nodeHttp, startGitHttpServer } from "../helpers/gitHttpServer";
import { createRepoWithOrigin } from "../helpers/gitRepo";
import { createWasmGitManager } from "../helpers/wasmGit";
import {
    managerFor,
    repoOf,
    expectFsckClean,
} from "../helpers/wasmGitFixtures";
import { describe, expect, it } from "vitest";

describe("WasmGit fetch and push over smart HTTP", { timeout: 300_000 }, () => {
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

describe("WasmGit phase 4 review regressions", { timeout: 300_000 }, () => {
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

describe("WasmGit init and clone", { timeout: 300_000 }, () => {
    it("clones over HTTP into a vault folder, shallow or full", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        await repo.writeAndCommit("dir/a.md", "a\n", "a");
        writeFileSync(
            path.join(repo.repoPath, "pic.bin"),
            randomBytes(200_000)
        );
        await repo.raw(["add", "pic.bin"]);
        await repo.git.commit("pic");
        await repo.git.push(["--quiet"]);
        const server = await startGitHttpServer(repo.dir);
        try {
            for (const depth of [undefined, 1]) {
                const vault = path.join(repo.dir, `vault-${depth ?? "full"}`);
                execFileSync("mkdir", ["-p", vault]);
                const { manager, plugin } = createWasmGitManager(vault, {
                    vaultPath: vault,
                    basePath: "cloned",
                });
                manager.http = nodeHttp;
                plugin.settings.disablePopups = true;
                await manager.clone(server.url("remote.git"), "cloned", depth);

                const cloned = path.join(vault, "cloned");
                const g = (...args: string[]) =>
                    execFileSync("git", args, {
                        cwd: cloned,
                        encoding: "utf8",
                    }).trim();
                expect(g("status", "--porcelain")).toBe("");
                expect(g("rev-parse", "HEAD")).toBe(await repo.head());
                expect(g("rev-parse", "--abbrev-ref", "main@{upstream}")).toBe(
                    "origin/main"
                );
                expect(g("rev-list", "--count", "HEAD")).toBe(
                    depth
                        ? "1"
                        : await repo.raw(["rev-list", "--count", "HEAD"])
                );
                execFileSync("git", ["fsck", "--strict", "--no-dangling"], {
                    cwd: cloned,
                });
                expect((await manager.status()).all).toEqual([]);
                expect(await manager.checkRequirements()).toBe("valid");
            }
        } finally {
            await server.close();
        }
    });

    it("refuses to overwrite an existing note when cloning into the vault root", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        const server = await startGitHttpServer(repo.dir);
        try {
            const vault = path.join(repo.dir, "vault");
            execFileSync("mkdir", ["-p", vault]);
            writeFileSync(path.join(vault, "note.md"), "my local note\n");
            const { manager, plugin } = createWasmGitManager(vault, {
                vaultPath: vault,
            });
            manager.http = nodeHttp;
            plugin.settings.disablePopups = true;
            await expect(
                manager.clone(server.url("remote.git"), ".")
            ).rejects.toThrow(/note\.md/);
            expect(readFileSync(path.join(vault, "note.md"), "utf8")).toBe(
                "my local note\n"
            );
        } finally {
            await server.close();
        }
    });

    it("initializes a repository git can use", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        const vault = path.join(repo.dir, "fresh");
        execFileSync("mkdir", ["-p", vault]);
        const { manager } = createWasmGitManager(vault, { vaultPath: vault });
        expect(await manager.checkRequirements()).toBe("missing-repo");
        await manager.init();
        expect(await manager.checkRequirements()).toBe("valid");
        expect(
            execFileSync("git", ["symbolic-ref", "HEAD"], {
                cwd: vault,
                encoding: "utf8",
            }).trim()
        ).toBe("refs/heads/main");
        await manager.setConfig("user.name", "N");
        await manager.setConfig("user.email", "n@x");
        writeFileSync(path.join(vault, "a.md"), "a\n");
        expect(await manager.commitAll({ message: "first" })).toBe(1);
        execFileSync("git", ["fsck", "--strict"], { cwd: vault });
    });
});

describe("WasmGit phase 6 review regressions", { timeout: 300_000 }, () => {
    it("leaves nothing behind when a clone fails, so it can be retried", async () => {
        const repo = withCleanup(await createRepoWithOrigin());
        await repo.raw(["tag", "v1"]);
        await repo.raw(["push", "-q", "origin", "v1"]);
        const server = await startGitHttpServer(repo.dir);
        try {
            const vault = path.join(repo.dir, "vault");
            execFileSync("mkdir", ["-p", vault]);
            writeFileSync(path.join(vault, "note.md"), "in the way\n");
            const { manager, plugin } = createWasmGitManager(vault, {
                vaultPath: vault,
            });
            manager.http = nodeHttp;
            plugin.settings.disablePopups = true;

            await expect(
                manager.clone(server.url("missing.git"), ".")
            ).rejects.toThrow();
            expect(await manager.checkRequirements()).toBe("missing-repo");
            await expect(
                manager.clone(server.url("remote.git"), ".")
            ).rejects.toThrow(/note\.md/);
            expect(await manager.checkRequirements()).toBe("missing-repo");

            execFileSync("rm", [path.join(vault, "note.md")]);
            await manager.clone(server.url("remote.git"), ".");
            expect(await manager.checkRequirements()).toBe("valid");
            const g = (...args: string[]) =>
                execFileSync("git", args, {
                    cwd: vault,
                    encoding: "utf8",
                }).trim();
            expect(g("status", "--porcelain")).toBe("");
            expect(g("tag")).toBe("v1");
            expect(g("config", "core.ignorecase")).toBe("true");
        } finally {
            await server.close();
        }
    });
});
