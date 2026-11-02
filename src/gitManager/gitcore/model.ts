// Git object formats: trees, commits, tags.

export type ObjectType = "commit" | "tree" | "blob" | "tag";

export const MODE_TREE = "40000";
export const MODE_FILE = "100644";
export const MODE_EXEC = "100755";
export const MODE_SYMLINK = "120000";
export const MODE_GITLINK = "160000";

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export interface TreeEntry {
    mode: string;
    name: string;
    oid: string;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function toHex(bytes: Uint8Array): string {
    let s = "";
    for (const b of bytes) s += b.toString(16).padStart(2, "0");
    return s;
}

export function fromHex(hex: string): Uint8Array {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < out.length; i++) {
        out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
    }
    return out;
}

export function parseTree(data: Uint8Array): TreeEntry[] {
    const entries: TreeEntry[] = [];
    let i = 0;
    while (i < data.length) {
        const space = data.indexOf(0x20, i);
        const nul = data.indexOf(0, space);
        if (space < 0 || nul < 0 || nul + 21 > data.length) {
            throw new Error("Corrupt tree object");
        }
        entries.push({
            mode: decoder.decode(data.subarray(i, space)),
            name: decoder.decode(data.subarray(space + 1, nul)),
            oid: toHex(data.subarray(nul + 1, nul + 21)),
        });
        i = nul + 21;
    }
    return entries;
}

/** Git's tree order: byte order of names, with trees compared as if suffixed by "/". */
export function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
    const ka = encoder.encode(a.mode === MODE_TREE ? a.name + "/" : a.name);
    const kb = encoder.encode(b.mode === MODE_TREE ? b.name + "/" : b.name);
    const n = Math.min(ka.length, kb.length);
    for (let i = 0; i < n; i++) {
        if (ka[i] !== kb[i]) return ka[i]! - kb[i]!;
    }
    return ka.length - kb.length;
}

export function serializeTree(entries: TreeEntry[]): Uint8Array {
    const sorted = [...entries].sort(compareTreeEntries);
    const parts: Uint8Array[] = [];
    let size = 0;
    for (const e of sorted) {
        const head = encoder.encode(`${e.mode} ${e.name}\0`);
        parts.push(head, fromHex(e.oid));
        size += head.length + 20;
    }
    const out = new Uint8Array(size);
    let off = 0;
    for (const p of parts) {
        out.set(p, off);
        off += p.length;
    }
    return out;
}

export interface Person {
    name: string;
    email: string;
    /** Seconds since the epoch. */
    timestamp: number;
    /** As written by git, e.g. "+0200". */
    timezone: string;
}

export interface Commit {
    tree: string;
    parents: string[];
    author: Person;
    committer: Person;
    /** Everything after the header block, including the trailing newline. */
    message: string;
    /** Headers this implementation does not interpret (gpgsig, encoding, ...). */
    extraHeaders: [string, string][];
}

function parsePerson(value: string): Person {
    const m = /^(.*) <(.*)> (-?\d+) ([+-]\d{4})$/.exec(value);
    if (!m) return { name: value, email: "", timestamp: 0, timezone: "+0000" };
    return {
        name: m[1]!,
        email: m[2]!,
        timestamp: Number(m[3]),
        timezone: m[4]!,
    };
}

function formatPerson(p: Person): string {
    return `${p.name} <${p.email}> ${p.timestamp} ${p.timezone}`;
}

/** Parse the header block of a commit or tag into ordered key/value pairs. */
function parseHeaders(text: string): {
    headers: [string, string][];
    message: string;
} {
    const end = text.indexOf("\n\n");
    const head = end < 0 ? text : text.slice(0, end);
    const message = end < 0 ? "" : text.slice(end + 2);
    const headers: [string, string][] = [];
    for (const line of head.split("\n")) {
        if (line.startsWith(" ") && headers.length > 0) {
            headers[headers.length - 1]![1] += "\n" + line.slice(1);
        } else if (line.length > 0) {
            const sp = line.indexOf(" ");
            headers.push([line.slice(0, sp), line.slice(sp + 1)]);
        }
    }
    return { headers, message };
}

export function parseCommit(data: Uint8Array): Commit {
    const { headers, message } = parseHeaders(decoder.decode(data));
    const commit: Commit = {
        tree: "",
        parents: [],
        author: parsePerson(""),
        committer: parsePerson(""),
        message,
        extraHeaders: [],
    };
    for (const [k, v] of headers) {
        if (k === "tree") commit.tree = v;
        else if (k === "parent") commit.parents.push(v);
        else if (k === "author") commit.author = parsePerson(v);
        else if (k === "committer") commit.committer = parsePerson(v);
        else commit.extraHeaders.push([k, v]);
    }
    if (!commit.tree) throw new Error("Corrupt commit object: no tree");
    return commit;
}

export function serializeCommit(c: Commit): Uint8Array {
    let s = `tree ${c.tree}\n`;
    for (const p of c.parents) s += `parent ${p}\n`;
    s += `author ${formatPerson(c.author)}\n`;
    s += `committer ${formatPerson(c.committer)}\n`;
    for (const [k, v] of c.extraHeaders) {
        s += `${k} ${v.replace(/\n/g, "\n ")}\n`;
    }
    s += `\n${c.message}`;
    return encoder.encode(s);
}

export interface Tag {
    object: string;
    type: ObjectType;
}

export function parseTag(data: Uint8Array): Tag {
    const { headers } = parseHeaders(decoder.decode(data));
    const get = (k: string) => headers.find(([key]) => key === k)?.[1];
    const object = get("object");
    const type = get("type") as ObjectType | undefined;
    if (!object || !type) throw new Error("Corrupt tag object");
    return { object, type };
}

/** Timezone offset string for a Date in the local zone, e.g. "+0200". */
export function localTimezone(date: Date): string {
    const minutes = -date.getTimezoneOffset();
    const sign = minutes >= 0 ? "+" : "-";
    const abs = Math.abs(minutes);
    return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}${String(abs % 60).padStart(2, "0")}`;
}
