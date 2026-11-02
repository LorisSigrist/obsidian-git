import ignore, { type Ignore } from "ignore";
import type { RepoFs } from "./repoFs";

/**
 * `.gitignore` files (in every directory) plus `info/exclude`, with git's
 * precedence: deeper files override shallower ones, and nothing below an
 * ignored directory can be re-included.
 */
export class IgnoreRules {
    private readonly perDir = new Map<string, Promise<Ignore | null>>();
    private exclude: Promise<Ignore | null> | undefined;
    private readonly dirResults = new Map<string, boolean>();

    constructor(
        private readonly fs: RepoFs,
        /** Vault path of the repository root ("" for the vault root). */
        private readonly root: string,
        private readonly gitdir: string
    ) {}

    private vaultPath(rel: string): string {
        if (!this.root) return rel;
        return rel ? `${this.root}/${rel}` : this.root;
    }

    private load(path: string): Promise<Ignore | null> {
        return this.fs.readText(path).then((text) => {
            if (text === null) return null;
            return ignore({ allowRelativePaths: true }).add(text);
        });
    }

    private rulesFor(dir: string): Promise<Ignore | null> {
        let p = this.perDir.get(dir);
        if (!p) {
            p = this.load(
                this.vaultPath(dir ? `${dir}/.gitignore` : ".gitignore")
            );
            this.perDir.set(dir, p);
        }
        return p;
    }

    /** Whether a repository-relative path is ignored. */
    async isIgnored(path: string, isDir = false): Promise<boolean> {
        const slash = path.lastIndexOf("/");
        const parent = slash < 0 ? "" : path.slice(0, slash);
        if (parent && (await this.isDirIgnored(parent))) return true;
        return this.matchOwn(path, isDir);
    }

    private async isDirIgnored(dir: string): Promise<boolean> {
        const known = this.dirResults.get(dir);
        if (known !== undefined) return known;
        const result = await this.isIgnored(dir, true);
        this.dirResults.set(dir, result);
        return result;
    }

    /** Apply the rules of `path`'s ancestors, shallowest first; the last match wins. */
    private async matchOwn(path: string, isDir: boolean): Promise<boolean> {
        let ignored = false;
        const apply = (rules: Ignore | null, rel: string) => {
            if (!rules) return;
            const r = rules.test(isDir ? `${rel}/` : rel);
            if (r.ignored) ignored = true;
            else if (r.unignored) ignored = false;
        };
        this.exclude ??= this.load(`${this.gitdir}/info/exclude`);
        apply(await this.exclude, path);
        const parts = path.split("/");
        for (let i = 0; i < parts.length; i++) {
            const dir = parts.slice(0, i).join("/");
            apply(await this.rulesFor(dir), parts.slice(i).join("/"));
        }
        return ignored;
    }
}
