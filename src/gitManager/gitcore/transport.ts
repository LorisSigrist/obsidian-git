// Git's smart HTTP protocol (v0/v1, stateless RPC): pkt-lines, ref discovery,
// side-band demultiplexing and authentication.

import { HttpError, UserCanceledError } from "./errors";

export interface HttpRequest {
    url: string;
    method: "GET" | "POST";
    headers: Record<string, string>;
    body?: Uint8Array;
}

export interface HttpResponse {
    status: number;
    headers: Record<string, string>;
    body: Uint8Array;
}

/** Performs one HTTP request; the plugin uses Obsidian's requestUrl. */
export type HttpClient = (req: HttpRequest) => Promise<HttpResponse>;

export interface Credentials {
    username?: string;
    password?: string;
}

export interface AuthCallbacks {
    /** Credentials to try when the server asks for them. */
    onAuth?: (url: string) => Credentials | Promise<Credentials>;
    /** The credentials were rejected: new ones, or `{ cancel: true }`. */
    onAuthFailure?: (
        url: string,
        tried: Credentials
    ) => Promise<Credentials | { cancel: true }>;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// ---- pkt-line ----

export function pktLine(text: string | Uint8Array): Uint8Array {
    const payload = typeof text === "string" ? encoder.encode(text) : text;
    const len = (payload.length + 4).toString(16).padStart(4, "0");
    const out = new Uint8Array(payload.length + 4);
    out.set(encoder.encode(len));
    out.set(payload, 4);
    return out;
}

export const FLUSH = encoder.encode("0000");

export function concat(parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let off = 0;
    for (const p of parts) {
        out.set(p, off);
        off += p.length;
    }
    return out;
}

/** A pkt-line payload, or null for a flush/delimiter packet. */
export type Packet = Uint8Array | null;

export class PktReader {
    private off = 0;

    constructor(private readonly data: Uint8Array) {}

    get done(): boolean {
        return this.off >= this.data.length;
    }

    /** The next packet; throws on truncated input. */
    next(): Packet {
        if (this.off + 4 > this.data.length) {
            throw new Error("Truncated response from the git server");
        }
        const len = parseInt(
            decoder.decode(this.data.subarray(this.off, this.off + 4)),
            16
        );
        if (Number.isNaN(len)) {
            throw new Error("Malformed response from the git server");
        }
        if (len < 4) {
            this.off += 4;
            return null;
        }
        if (this.off + len > this.data.length) {
            throw new Error("Truncated response from the git server");
        }
        const payload = this.data.subarray(this.off + 4, this.off + len);
        this.off += len;
        return payload;
    }

    /** The next packet as text without the trailing newline, or null for flush. */
    nextLine(): string | null {
        const p = this.next();
        return p === null ? null : decoder.decode(p).replace(/\n$/, "");
    }

    /** The unread rest (e.g. a pack sent without side-band). */
    rest(): Uint8Array {
        const r = this.data.subarray(this.off);
        this.off = this.data.length;
        return r;
    }

    peekText(n: number): string {
        return decoder.decode(this.data.subarray(this.off, this.off + n));
    }
}

/**
 * Split side-band-64k packets: band 1 is data, band 2 progress, band 3 a fatal
 * error. Calls `onData` for every band-1 payload, in order.
 */
export function demuxSideband(
    reader: PktReader,
    onData: (chunk: Uint8Array) => void,
    onProgress?: (message: string) => void
): void {
    while (!reader.done) {
        const p = reader.next();
        if (p === null) break;
        const band = p[0];
        const payload = p.subarray(1);
        if (band === 1) onData(payload);
        else if (band === 2) onProgress?.(decoder.decode(payload));
        else if (band === 3) {
            throw new Error(`Remote error: ${decoder.decode(payload).trim()}`);
        } else {
            throw new Error(`Unexpected side-band ${band}`);
        }
    }
}

// ---- URLs and auth ----

/** Split credentials out of a URL (`https://user:pass@host/x`). */
export function parseRemoteUrl(url: string): {
    url: string;
    credentials?: Credentials;
} {
    const m = /^(https?:\/\/)([^@/]+)@(.*)$/.exec(url);
    if (!m) return { url };
    // Only the first colon separates user from password.
    const colon = m[2]!.indexOf(":");
    const user = colon < 0 ? m[2]! : m[2]!.slice(0, colon);
    const pass = colon < 0 ? undefined : m[2]!.slice(colon + 1);
    return {
        url: m[1]! + m[3]!,
        credentials: {
            username: decodeURIComponent(user ?? ""),
            password: pass === undefined ? undefined : decodeURIComponent(pass),
        },
    };
}

function basic(c: Credentials): string {
    const raw = `${c.username ?? ""}:${c.password ?? ""}`;
    const bytes = encoder.encode(raw);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return `Basic ${btoa(bin)}`;
}

/**
 * An HTTP session against one remote that answers 401s by asking for
 * credentials (once from `onAuth`, then from `onAuthFailure` until the user
 * cancels), and keeps working credentials for later requests.
 */
export class GitHttpSession {
    private credentials: Credentials | undefined;
    readonly url: string;

    constructor(
        private readonly http: HttpClient,
        url: string,
        private readonly auth: AuthCallbacks = {}
    ) {
        const parsed = parseRemoteUrl(url.replace(/\/+$/, ""));
        this.url = parsed.url;
        this.credentials = parsed.credentials;
    }

    async request(req: Omit<HttpRequest, "url"> & { path: string }) {
        const send = (creds: Credentials | undefined) =>
            this.http({
                url: this.url + req.path,
                method: req.method,
                headers: {
                    "User-Agent": "git/obsidian-git",
                    ...req.headers,
                    ...(creds ? { Authorization: basic(creds) } : {}),
                },
                body: req.body,
            });
        let res = await send(this.credentials);
        if (res.status === 401 && !this.credentials && this.auth.onAuth) {
            this.credentials = await this.auth.onAuth(this.url);
            res = await send(this.credentials);
        }
        while (res.status === 401 && this.auth.onAuthFailure) {
            const next = await this.auth.onAuthFailure(
                this.url,
                this.credentials ?? {}
            );
            if ("cancel" in next) throw new UserCanceledError();
            this.credentials = next;
            res = await send(this.credentials);
        }
        if (res.status < 200 || res.status >= 300) {
            throw new HttpError(
                res.status,
                String(res.status),
                decoder.decode(res.body.subarray(0, 512))
            );
        }
        return res;
    }
}

// ---- Ref discovery ----

export interface RemoteRefs {
    /** Full ref name → oid (peeled tags as "name^{}"). */
    refs: Map<string, string>;
    capabilities: Set<string>;
    /** Where the remote's HEAD points, if advertised (symref capability). */
    headTarget?: string;
}

function header(res: HttpResponse, name: string): string {
    const key = Object.keys(res.headers).find(
        (k) => k.toLowerCase() === name.toLowerCase()
    );
    return key ? res.headers[key]! : "";
}

export async function discoverRefs(
    session: GitHttpSession,
    service: "git-upload-pack" | "git-receive-pack"
): Promise<RemoteRefs> {
    const res = await session.request({
        path: `/info/refs?service=${service}`,
        method: "GET",
        headers: { Accept: "*/*" },
    });
    if (
        !header(res, "content-type").startsWith(
            `application/x-${service}-advertisement`
        )
    ) {
        throw new Error(
            "The remote does not speak git's smart HTTP protocol (dumb HTTP servers are not supported)."
        );
    }
    const reader = new PktReader(res.body);
    const first = reader.nextLine();
    if (first !== `# service=${service}`) {
        throw new Error("Unexpected ref advertisement from the git server");
    }
    // A flush separates the service line from the refs.
    if (reader.next() !== null) {
        throw new Error("Unexpected ref advertisement from the git server");
    }
    const refs = new Map<string, string>();
    const capabilities = new Set<string>();
    let headTarget: string | undefined;
    let firstRef = true;
    while (!reader.done) {
        const line = reader.next();
        if (line === null) break;
        let text = decoder.decode(line).replace(/\n$/, "");
        if (firstRef) {
            const nul = text.indexOf("\0");
            if (nul >= 0) {
                for (const cap of text.slice(nul + 1).split(" ")) {
                    if (!cap) continue;
                    capabilities.add(cap);
                    if (cap.startsWith("symref=HEAD:")) {
                        headTarget = cap.slice("symref=HEAD:".length);
                    }
                }
                text = text.slice(0, nul);
            }
            firstRef = false;
        }
        const [oid, name] = text.split(" ");
        // An empty repository advertises "0000... capabilities^{}".
        if (oid && name && name !== "capabilities^{}") refs.set(name, oid);
    }
    return { refs, capabilities, headTarget };
}
