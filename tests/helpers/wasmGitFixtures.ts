import { execFileSync } from "child_process";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import path from "path";
import { expect } from "vitest";
import type { Repository } from "../../src/gitManager/gitcore/repository";
import type { WasmGit } from "../../src/gitManager/wasmGit";
import { createRepoWithOrigin, type TestRepo } from "./gitRepo";
import { createWasmGitManager } from "./wasmGit";

/** A WasmGit on a fixture repo, with the vault one level above (basePath "worktree"). */
export function managerFor(repo: TestRepo): WasmGit {
    return createWasmGitManager(repo.repoPath, {
        vaultPath: repo.dir,
        basePath: "worktree",
    }).manager;
}

export function repoOf(manager: WasmGit): Promise<Repository> {
    return (manager as unknown as { repo(): Promise<Repository> }).repo();
}

/** Run git directly in the fixture's worktree (much faster than simple-git). */
export function git(repo: TestRepo, ...args: string[]): string {
    return execFileSync("git", args, {
        cwd: repo.repoPath,
        encoding: "utf8",
    }).trim();
}

function write(repo: TestRepo, file: string, content: string): void {
    const full = path.join(repo.repoPath, file);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
}

function commitFile(
    repo: TestRepo,
    file: string,
    content: string,
    message: string
): void {
    write(repo, file, content);
    git(repo, "add", "-f", file);
    git(repo, "commit", "-q", "-m", message);
}

/** `git status --porcelain` as path → two-letter code, untracked as "UU" like the plugin. */
export async function nativeStatus(
    repo: TestRepo
): Promise<Map<string, string>> {
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
        map.set(line.slice(3), line.slice(0, 2).replace(/\?/g, "U"));
    }
    return map;
}

export async function ourStatus(
    manager: WasmGit
): Promise<Map<string, string>> {
    const status = await manager.status();
    return new Map(status.all.map((f) => [f.path, f.index + f.workingDir]));
}

/** A repository with history, branches, ignore rules and a merge. */
export async function richRepo(): Promise<TestRepo> {
    const repo = await createRepoWithOrigin();
    commitFile(
        repo,
        ".gitignore",
        "*.log\nbuild/\n!keep.log\ndeep/**/secret.md\n",
        "ignore rules"
    );
    commitFile(repo, "dir/a.md", "a\n", "a");
    commitFile(repo, "dir/sub/b.md", "b\n", "b");
    commitFile(repo, "dir/sub/.gitignore", "local.md\n", "nested ignore");
    commitFile(repo, "deleted.md", "gone soon\n", "to delete");
    commitFile(repo, "staged-then-edited.md", "v1\n", "v1");
    // A tracked file that matches an ignore rule stays tracked.
    commitFile(repo, "tracked.log", "tracked\n", "tracked log");
    git(repo, "checkout", "-q", "-b", "feature");
    commitFile(repo, "feature.md", "feature\n", "feature work");
    git(repo, "checkout", "-q", "main");
    git(repo, "merge", "-q", "--no-ff", "-m", "merge feature", "feature");
    git(repo, "push", "-q");
    commitFile(repo, "local-only.md", "unpushed\n", "unpushed");
    return repo;
}

/** Every kind of working-tree change on top of richRepo(). */
export function makeChanges(repo: TestRepo): Promise<void> {
    write(repo, "note.md", "modified\n");
    write(repo, "dir/sub/b.md", "b changed\n");
    write(repo, "new-staged.md", "new\n");
    git(repo, "add", "new-staged.md");
    write(repo, "staged-then-edited.md", "v2\n");
    git(repo, "add", "staged-then-edited.md");
    write(repo, "staged-then-edited.md", "v3\n");
    rmSync(path.join(repo.repoPath, "deleted.md"));
    write(repo, "untracked.md", "u\n");
    write(repo, "dir/untracked-deep/x.md", "x\n");
    write(repo, "ignored.log", "ignored\n");
    write(repo, "keep.log", "re-included\n");
    write(repo, "build/out.md", "ignored dir\n");
    write(repo, "deep/a/b/secret.md", "ignored glob\n");
    write(repo, "dir/sub/local.md", "ignored by nested file\n");
    write(repo, "tracked.log", "tracked and changed\n");
    write(repo, ".obsidian/workspace.json", "{}\n");
    return Promise.resolve();
}

/** Native git must accept everything we wrote. */
export async function expectFsckClean(repo: TestRepo): Promise<void> {
    await expect(
        repo.raw(["fsck", "--full", "--strict", "--no-dangling"])
    ).resolves.toBe("");
}
