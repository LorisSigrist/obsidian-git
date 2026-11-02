import {
    appendFile,
    open,
    mkdir,
    readFile,
    readdir,
    rename,
    rm,
    rmdir as rmdirFs,
    stat,
    writeFile,
} from "fs/promises";
import path from "path";
import { vi } from "vitest";
import { WasmGit } from "../../src/gitManager/wasmGit";
import { createFakePlugin, type FakePlugin } from "./createFakePlugin";

export type WasmGitTestContext = {
    manager: WasmGit;
    plugin: FakePlugin;
    setPluginState: ReturnType<typeof vi.fn>;
    updateCachedStatus: ReturnType<typeof vi.fn>;
};

/** A fake Obsidian vault on a real directory, with vault-relative paths. */
export function createNodeVault(root: string) {
    const resolve = (vaultPath: string): string =>
        path.join(root, vaultPath.replace(/^\/+/, ""));
    const relative = (vaultPath: string, name: string): string =>
        vaultPath === "/" || vaultPath === "" ? name : `${vaultPath}/${name}`;

    const adapter = {
        exists: async (vaultPath: string) => {
            try {
                await stat(resolve(vaultPath));
                return true;
            } catch {
                return false;
            }
        },
        read: (vaultPath: string) => readFile(resolve(vaultPath), "utf8"),
        readBinary: async (vaultPath: string) => {
            const data = await readFile(resolve(vaultPath));
            return data.buffer.slice(
                data.byteOffset,
                data.byteOffset + data.byteLength
            );
        },
        write: async (vaultPath: string, data: string) => {
            await mkdir(path.dirname(resolve(vaultPath)), { recursive: true });
            await writeFile(resolve(vaultPath), data);
        },
        writeBinary: async (vaultPath: string, data: ArrayBuffer) => {
            await mkdir(path.dirname(resolve(vaultPath)), { recursive: true });
            await writeFile(resolve(vaultPath), new Uint8Array(data));
        },
        stat: async (vaultPath: string) => {
            try {
                const result = await stat(resolve(vaultPath));
                return {
                    type: result.isDirectory() ? "folder" : "file",
                    ctime: result.ctimeMs,
                    mtime: result.mtimeMs,
                    size: result.size,
                };
            } catch {
                return null;
            }
        },
        list: async (vaultPath: string) => {
            const entries = await readdir(resolve(vaultPath), {
                withFileTypes: true,
            });
            return {
                files: entries
                    .filter((entry) => entry.isFile())
                    .map((entry) => relative(vaultPath, entry.name)),
                folders: entries
                    .filter((entry) => entry.isDirectory())
                    .map((entry) => relative(vaultPath, entry.name)),
            };
        },
        mkdir: (vaultPath: string) =>
            mkdir(resolve(vaultPath), { recursive: true }),
        // Like Obsidian: non-recursive rmdir removes an empty folder.
        rmdir: (vaultPath: string, recursive = false) =>
            recursive
                ? rm(resolve(vaultPath), { recursive, force: true })
                : rmdirFs(resolve(vaultPath)),
        remove: (vaultPath: string) =>
            rm(resolve(vaultPath), { recursive: true, force: true }),
        appendBinary: (vaultPath: string, data: ArrayBuffer) =>
            appendFile(resolve(vaultPath), new Uint8Array(data)),
        rename: async (from: string, to: string) => {
            await mkdir(path.dirname(resolve(to)), { recursive: true });
            await rename(resolve(from), resolve(to));
        },
    };

    return {
        adapter,
        create: adapter.write,
        createBinary: adapter.writeBinary,
        createFolder: adapter.mkdir,
        getAbstractFileByPath: () => null,
        getFolderByPath: () => null,
    };
}

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
