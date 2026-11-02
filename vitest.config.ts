import { readFileSync } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { defineConfig } from "vitest/config";

const dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
    plugins: [
        {
            // Mirror esbuild's binary loader: `import bytes from "x.wasm"` gives a Uint8Array.
            name: "wasm-binary",
            enforce: "pre",
            load(id: string) {
                if (!id.endsWith(".wasm")) return null;
                const bytes = readFileSync(id).toString("base64");
                return `export default Uint8Array.from(atob("${bytes}"), (c) => c.charCodeAt(0));`;
            },
        },
    ],
    resolve: {
        alias: {
            obsidian: path.resolve(dirname, "tests/stubs/obsidian.ts"),
            src: path.resolve(dirname, "src"),
        },
    },
    test: {
        environment: "node",
        include: ["tests/**/*.test.ts"],
        setupFiles: ["tests/setup.ts"],
        coverage: {
            provider: "v8",
            reporter: ["text", "html"],
            reportsDirectory: "coverage",
        },
    },
});
