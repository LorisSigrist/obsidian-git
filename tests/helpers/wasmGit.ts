import { open } from "fs/promises";
import path from "path";
import { vi } from "vitest";
import { WasmGit } from "../../src/gitManager/wasmGit";
import { createFakePlugin, type FakePlugin } from "./createFakePlugin";
import { createNodeVault } from "./isomorphicGit";

export type WasmGitTestContext = {
    manager: WasmGit;
    plugin: FakePlugin;
    setPluginState: ReturnType<typeof vi.fn>;
    updateCachedStatus: ReturnType<typeof vi.fn>;
};

/** Random access to vault files through Node, standing in for ranged resource requests. */
export function nodeRangeReader(root: string) {
    return async (vaultPath: string, offset: number, length: number) => {
        const handle = await open(path.join(root, vaultPath));
        try {
            const buf = new Uint8Array(length);
            const { bytesRead } = await handle.read(buf, 0, length, offset);
            return buf.subarray(0, bytesRead);
        } finally {
            await handle.close();
        }
    };
}

export function createWasmGitManager(
    repoPath: string,
    options: { vaultPath?: string; basePath?: string } = {}
): WasmGitTestContext {
    const plugin = createFakePlugin();
    plugin.settings = {
        basePath: options.basePath ?? "",
        gitDir: "",
        mergeStrategy: "none",
        listChangedFilesInMessageBody: false,
    } as FakePlugin["settings"];

    const setPluginState = vi.fn();
    const updateCachedStatus = vi.fn();
    plugin.localStorage = {
        getHostname: vi.fn().mockReturnValue(null),
    } as unknown as FakePlugin["localStorage"];
    plugin.setPluginState = setPluginState;
    plugin.updateCachedStatus = updateCachedStatus;
    const vaultPath = options.vaultPath ?? repoPath;
    (plugin.app as unknown as { vault: unknown }).vault =
        createNodeVault(vaultPath);

    const manager = new WasmGit(plugin);
    manager.rangeReader = nodeRangeReader(vaultPath);
    plugin.gitManager = manager;
    return { manager, plugin, setPluginState, updateCachedStatus };
}
