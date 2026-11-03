import path from "path";
import { execFileSync } from "child_process";
import { randomBytes } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import type { HttpClient } from "../../src/gitManager/gitcore/transport";
import type { GitProgress } from "../../src/types";
import { withCleanup } from "../helpers/cleanup";
import { nodeHttp, startGitHttpServer } from "../helpers/gitHttpServer";
import { createRepoWithOrigin } from "../helpers/gitRepo";
import { createWasmGitManager } from "../helpers/wasmGit";
import { repoOf } from "../helpers/wasmGitFixtures";
import { describe, expect, it } from "vitest";

const PDFS = 10;

/**
 * A remote with history and large-ish files, served like GitHub serves
 * repositories: partial clones and fetching objects by id are allowed.
 */
async function partialRemote() {
    const repo = withCleanup(await createRepoWithOrigin());
    await repo.writeAndCommit("note.md", "v1\n", "v1");
    const v1 = await repo.raw(["rev-parse", "HEAD:note.md"]);
    await repo.writeAndCommit("note.md", "v2\n", "v2");
    await repo.writeAndCommit(".obsidian/app.json", "{}\n", "config");
    execFileSync("mkdir", ["-p", path.join(repo.repoPath, "pics")]);
    for (let i = 0; i < PDFS; i++) {
        writeFileSync(
            path.join(repo.repoPath, `pics/p${i}.pdf`),
            randomBytes(100_000)
        );
    }
    await repo.raw(["add", "pics"]);
    await repo.git.commit("pics");
    await repo.git.push(["--quiet"]);
    for (const [key, value] of [
        ["uploadpack.allowFilter", "true"],
        ["uploadpack.allowAnySHA1InWant", "true"],
    ]) {
        execFileSync("git", ["config", key!, value!], {
            cwd: repo.remotePath,
        });
    }
    const server = await startGitHttpServer(repo.dir);
    return { repo, server, v1 };
}

function vaultManager(dir: string, name: string) {
    const vault = path.join(dir, name);
    execFileSync("mkdir", ["-p", vault]);
    const ctx = createWasmGitManager(vault, { vaultPath: vault });
    ctx.manager.http = nodeHttp;
    ctx.plugin.settings.disablePopups = true;
    const g = (...args: string[]) =>
        execFileSync("git", args, { cwd: vault, encoding: "utf8" }).trim();
    return { vault, g, ...ctx };
}

/** Counts the upload-pack requests (each one downloads a pack). */
function countingHttp(failOn?: number) {
    const counter = { packs: 0 };
    const http: HttpClient = async (req) => {
        if (req.url.endsWith("/git-upload-pack")) {
            counter.packs++;
            if (counter.packs === failOn) throw new Error("network down");
        }
        return nodeHttp(req);
    };
    return { counter, http };
}

describe("WasmGit partial clone", { timeout: 300_000 }, () => {
    it("clones commits first, then the current contents in batches", async () => {
        const { repo, server, v1 } = await partialRemote();
        try {
            const { manager, g, vault } = vaultManager(repo.dir, "vault");
            // A fresh vault's own config, which the repo's replaces.
            execFileSync("mkdir", ["-p", path.join(vault, ".obsidian")]);
            writeFileSync(path.join(vault, ".obsidian/app.json"), "local\n");
            const { counter, http } = countingHttp();
            manager.http = http;
            let downloadedBeforeCheckout = false;
            await manager.clone(server.url("remote.git"), ".", undefined, {
                beforeCheckout: () => {
                    downloadedBeforeCheckout = existsSync(
                        path.join(vault, ".git/objects/pack")
                    );
                    expect(existsSync(path.join(vault, "note.md"))).toBe(false);
                    execFileSync("rm", ["-rf", path.join(vault, ".obsidian")]);
                    return Promise.resolve();
                },
            });
            expect(downloadedBeforeCheckout).toBe(true);
            expect(
                readFileSync(path.join(vault, ".obsidian/app.json"), "utf8")
            ).toBe("{}\n");

            expect(g("status", "--porcelain")).toBe("");
            expect(g("rev-parse", "HEAD")).toBe(await repo.head());
            expect(g("rev-list", "--count", "HEAD")).toBe(
                await repo.raw(["rev-list", "--count", "HEAD"])
            );
            expect(g("config", "extensions.partialclone")).toBe("origin");
            expect(g("config", "remote.origin.promisor")).toBe("true");
            for (let i = 0; i < PDFS; i++) {
                expect(
                    readFileSync(path.join(vault, `pics/p${i}.pdf`))
                ).toEqual(
                    readFileSync(path.join(repo.repoPath, `pics/p${i}.pdf`))
                );
            }
            // The filtered fetch, a batch of text files and several small
            // batches of (possibly) large files.
            expect(counter.packs).toBeGreaterThanOrEqual(4);
            // The old version stayed on the server.
            expect(await (await repoOf(manager)).objects.has(v1)).toBe(false);
            expect(
                existsSync(path.join(vault, ".git/obsidian-git-clone"))
            ).toBe(false);
            // Git agrees that what is missing is on the promisor remote.
            execFileSync("git", ["fsck", "--no-dangling"], { cwd: vault });
            expect((await manager.status()).all).toEqual([]);
            expect(await manager.checkRequirements()).toBe("valid");
        } finally {
            await server.close();
        }
    });

    it("downloads older versions when they are needed", async () => {
        const { repo, server, v1 } = await partialRemote();
        try {
            const { manager } = vaultManager(repo.dir, "vault");
            await manager.clone(server.url("remote.git"), ".");
            const r = await repoOf(manager);
            expect(await r.objects.has(v1)).toBe(false);
            const obj = await r.objects.read(v1);
            expect(new TextDecoder().decode(obj.data)).toBe("v1\n");
            expect(await r.objects.has(v1)).toBe(true);
        } finally {
            await server.close();
        }
    });

    it("pulls and pushes in a partial clone", async () => {
        const { repo, server } = await partialRemote();
        try {
            const { manager, g, vault, plugin } = vaultManager(
                repo.dir,
                "vault"
            );
            await manager.clone(server.url("remote.git"), ".");
            await manager.setConfig("user.name", "Phone");
            await manager.setConfig("user.email", "phone@example.com");

            // Another device adds and changes files.
            writeFileSync(
                path.join(repo.repoPath, "pics/new.pdf"),
                randomBytes(50_000)
            );
            repo.write("note.md", "v3\n");
            await repo.raw(["add", "-A"]);
            await repo.git.commit("from desktop");
            await repo.git.push(["--quiet"]);

            const { counter, http } = countingHttp();
            manager.http = http;
            const stages: string[] = [];
            (plugin as unknown as { statusBar: unknown }).statusBar = {
                displayProgress: (p: GitProgress) => {
                    const s =
                        p.total !== undefined
                            ? `${p.stage} ${p.processed}/${p.total}`
                            : p.stage;
                    if (stages[stages.length - 1] !== s) stages.push(s);
                },
                clearProgress: () => {},
            };
            const pulled = await manager.pull();
            expect(stages[0]).toBe("checking for changes");
            expect(stages).toContain("downloading files 2/2");
            expect(stages).toContain("writing files 1/2");
            expect(stages.indexOf("downloading files 2/2")).toBeLessThan(
                stages.indexOf("writing files 0/2")
            );
            expect(pulled.status).toBe("updated");
            expect(readFileSync(path.join(vault, "note.md"), "utf8")).toBe(
                "v3\n"
            );
            expect(readFileSync(path.join(vault, "pics/new.pdf"))).toEqual(
                readFileSync(path.join(repo.repoPath, "pics/new.pdf"))
            );
            // The filtered fetch plus batched contents, not one per file.
            expect(counter.packs).toBeLessThanOrEqual(3);
            expect(g("status", "--porcelain")).toBe("");

            writeFileSync(path.join(vault, "phone.md"), "from the phone\n");
            await manager.commitAll({ message: "phone" });
            await manager.push();
            const remoteGit = (...args: string[]) =>
                execFileSync("git", args, {
                    cwd: repo.remotePath,
                    encoding: "utf8",
                }).trim();
            expect(remoteGit("show", "main:phone.md")).toBe("from the phone");
            execFileSync("git", ["fsck", "--strict", "--no-dangling"], {
                cwd: repo.remotePath,
            });
            execFileSync("git", ["fsck", "--no-dangling"], { cwd: vault });
        } finally {
            await server.close();
        }
    });

    it("resumes an interrupted clone and refuses to commit until it is done", async () => {
        const { repo, server } = await partialRemote();
        try {
            const { manager, g, vault } = vaultManager(repo.dir, "vault");
            // The third download fails: commits and one batch are stored.
            const failing = countingHttp(3);
            manager.http = failing.http;
            let checkedOut = 0;
            const beforeCheckout = () => {
                checkedOut++;
                return Promise.resolve();
            };
            await expect(
                manager.clone(server.url("remote.git"), ".", undefined, {
                    beforeCheckout,
                })
            ).rejects.toThrow(/did not finish.*resume/);
            expect(checkedOut).toBe(0);
            expect(
                existsSync(path.join(vault, ".git/obsidian-git-clone"))
            ).toBe(true);
            // Not a repository to work with yet: the plugin offers a clone.
            expect(await manager.checkRequirements()).toBe("missing-repo");
            writeFileSync(path.join(vault, "early.md"), "too early\n");
            await expect(
                manager.commitAll({ message: "too early" })
            ).rejects.toThrow(/has not finished/);
            await expect(manager.pull()).rejects.toThrow(/has not finished/);
            execFileSync("rm", [path.join(vault, "early.md")]);

            const resumed = countingHttp();
            manager.http = resumed.http;
            await manager.clone(server.url("remote.git"), ".", undefined, {
                beforeCheckout,
            });
            expect(checkedOut).toBe(1);
            // Only what was still missing: no second filtered fetch.
            expect(resumed.counter.packs).toBeLessThan(failing.counter.packs);
            expect(
                existsSync(path.join(vault, ".git/obsidian-git-clone"))
            ).toBe(false);
            expect(g("status", "--porcelain")).toBe("");
            expect(g("rev-parse", "HEAD")).toBe(await repo.head());
            execFileSync("git", ["fsck", "--no-dangling"], { cwd: vault });
        } finally {
            await server.close();
        }
    });

    it("starts over when an unfinished clone was of another repository", async () => {
        const { repo, server } = await partialRemote();
        try {
            const { manager, vault } = vaultManager(repo.dir, "vault");
            manager.http = countingHttp(3).http;
            await expect(
                manager.clone(server.url("remote.git"), ".")
            ).rejects.toThrow(/did not finish/);
            manager.http = nodeHttp;
            await expect(
                manager.clone(server.url("missing.git"), ".")
            ).rejects.toThrow();
            expect(existsSync(path.join(vault, ".git"))).toBe(false);
            await manager.clone(server.url("remote.git"), ".");
            expect(await manager.checkRequirements()).toBe("valid");
        } finally {
            await server.close();
        }
    });

    it("checks for files in the way before the config folder is replaced", async () => {
        const { repo, server } = await partialRemote();
        try {
            const { manager, vault } = vaultManager(repo.dir, "vault");
            execFileSync("mkdir", ["-p", path.join(vault, ".obsidian")]);
            writeFileSync(path.join(vault, ".obsidian/app.json"), "local\n");
            writeFileSync(path.join(vault, "note.md"), "my own note\n");
            let called = false;
            await expect(
                manager.clone(server.url("remote.git"), ".", undefined, {
                    beforeCheckout: () => {
                        called = true;
                        return Promise.resolve();
                    },
                })
            ).rejects.toThrow(/note\.md/);
            expect(called).toBe(false);
            expect(
                readFileSync(path.join(vault, ".obsidian/app.json"), "utf8")
            ).toBe("local\n");
            expect(readFileSync(path.join(vault, "note.md"), "utf8")).toBe(
                "my own note\n"
            );
        } finally {
            await server.close();
        }
    });

    it("clones fully from a server that cannot send contents by id", async () => {
        const { repo, server } = await partialRemote();
        try {
            execFileSync(
                "git",
                ["config", "--unset", "uploadpack.allowAnySHA1InWant"],
                { cwd: repo.remotePath }
            );
            const { manager, g } = vaultManager(repo.dir, "vault");
            await manager.clone(server.url("remote.git"), ".");
            expect(g("status", "--porcelain")).toBe("");
            expect(() => g("config", "extensions.partialclone")).toThrow();
            execFileSync("git", ["fsck", "--strict", "--no-dangling"], {
                cwd: path.join(repo.dir, "vault"),
            });
        } finally {
            await server.close();
        }
    });
});
