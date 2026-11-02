import { spawn } from "child_process";
import http from "http";
import type { AddressInfo } from "net";
import type { HttpClient } from "../../src/gitManager/gitcore/transport";

export interface GitHttpServer {
    /** URL of a repository below the project root, e.g. url("remote.git"). */
    url(repo: string): string;
    /** Number of requests served, by method and path. */
    requests: string[];
    close(): Promise<void>;
}

/**
 * Serves the repositories below `root` over git's smart HTTP protocol via
 * `git http-backend`, optionally behind Basic auth. Pushes are allowed.
 */
export async function startGitHttpServer(
    root: string,
    auth?: { username: string; password: string }
): Promise<GitHttpServer> {
    const requests: string[] = [];
    const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        requests.push(`${req.method} ${url.pathname}`);
        if (auth) {
            const expected = `Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString("base64")}`;
            if (req.headers.authorization !== expected) {
                res.writeHead(401, { "WWW-Authenticate": 'Basic realm="git"' });
                res.end();
                return;
            }
        }
        const env: NodeJS.ProcessEnv = {
            ...process.env,
            GIT_PROJECT_ROOT: root,
            GIT_HTTP_EXPORT_ALL: "1",
            PATH_INFO: url.pathname,
            QUERY_STRING: url.search.slice(1),
            REQUEST_METHOD: req.method ?? "GET",
            CONTENT_TYPE: req.headers["content-type"] ?? "",
            REMOTE_USER: "tester",
            REMOTE_ADDR: "127.0.0.1",
        };
        if (req.headers["content-length"]) {
            env.CONTENT_LENGTH = req.headers["content-length"];
        }
        const cgi = spawn("git", ["http-backend"], { env });
        req.pipe(cgi.stdin);
        const out: Buffer[] = [];
        cgi.stdout.on("data", (d: Buffer) => out.push(d));
        cgi.on("close", () => {
            const all = Buffer.concat(out);
            const split = all.indexOf("\r\n\r\n");
            const head = all.subarray(0, split).toString();
            const body = all.subarray(split + 4);
            let status = 200;
            const headers: Record<string, string> = {};
            for (const line of head.split("\r\n")) {
                const colon = line.indexOf(":");
                const key = line.slice(0, colon).trim();
                const value = line.slice(colon + 1).trim();
                if (key.toLowerCase() === "status") status = parseInt(value);
                else headers[key] = value;
            }
            res.writeHead(status, headers);
            res.end(body);
        });
    });
    await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve)
    );
    const { port } = server.address() as AddressInfo;
    return {
        url: (repo) => `http://127.0.0.1:${port}/${repo}`,
        requests,
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
}

/** An HttpClient on Node's fetch, standing in for Obsidian's requestUrl. */
export const nodeHttp: HttpClient = async ({ url, method, headers, body }) => {
    const res = await fetch(url, {
        method,
        headers,
        body: body as Uint8Array<ArrayBuffer> | undefined,
    });
    const resHeaders: Record<string, string> = {};
    res.headers.forEach((value, key) => (resHeaders[key] = value));
    return {
        status: res.status,
        headers: resHeaders,
        body: new Uint8Array(await res.arrayBuffer()),
    };
};
