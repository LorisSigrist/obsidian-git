import path from "path";
import type { GitManager } from "../../src/gitManager/gitManager";
import type { FakePlugin } from "./createFakePlugin";
import { createRepoWithOrigin, type TestRepo } from "./gitRepo";
import { createSimpleGitTestContext, type GitFixture } from "./simpleGit";
import { createWasmGitManager } from "./wasmGit";

export interface GitManagerTestHarness {
    manager: GitManager;
    repo: TestRepo;
    plugin: FakePlugin;
    cleanup(): void;
}

export interface GitManagerBackend {
    name: string;
    create(fixture?: GitFixture): Promise<GitManagerTestHarness>;
}

function getVaultOptions(repo: TestRepo): {
    vaultPath: string;
    basePath: string;
} {
    return {
        vaultPath: repo.dir,
        basePath: path
            .relative(repo.dir, repo.repoPath)
            .split(path.sep)
            .join("/"),
    };
}

async function createSimpleGitHarness(
    fixture?: GitFixture
): Promise<GitManagerTestHarness> {
    return createSimpleGitTestContext({
        fixture,
        getVaultOptions,
    });
}

async function createWasmGitHarness(
    fixture?: GitFixture
): Promise<GitManagerTestHarness> {
    const repo = await (fixture ?? createRepoWithOrigin)();
    const { manager, plugin } = createWasmGitManager(
        repo.repoPath,
        getVaultOptions(repo)
    );
    return {
        manager,
        repo,
        plugin,
        cleanup: () => {
            manager.unload();
            repo.cleanup();
        },
    };
}

export const gitManagerBackends: GitManagerBackend[] = [
    {
        name: "simple-git",
        create: createSimpleGitHarness,
    },
    {
        name: "wasm-git",
        create: createWasmGitHarness,
    },
];
