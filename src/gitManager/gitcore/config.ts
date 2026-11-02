// Reading and editing git config files, keeping every untouched line as it was.

interface Line {
    raw: string;
    /** Lower-cased section and case-sensitive subsection this line belongs to. */
    section: string;
    subsection: string | undefined;
    /** Lower-cased variable name, for variable lines. */
    key?: string;
    value?: string;
    isHeader?: boolean;
}

/**
 * Decode a config value: quotes group text (whitespace inside them is kept),
 * backslash escapes, `;`/`#` start a comment outside quotes, and unquoted
 * leading/trailing whitespace is dropped.
 */
function parseValue(raw: string): string {
    let out = "";
    let quoted = false;
    let started = false;
    // Unquoted whitespace is held back until we know it is not trailing.
    let pending = "";
    const emit = (text: string) => {
        out += pending + text;
        pending = "";
        started = true;
    };
    for (let i = 0; i < raw.length; i++) {
        const c = raw[i]!;
        if (c === '"') {
            quoted = !quoted;
            emit("");
        } else if (c === "\\" && i + 1 < raw.length) {
            const n = raw[++i]!;
            emit(n === "n" ? "\n" : n === "t" ? "\t" : n === "b" ? "\b" : n);
        } else if ((c === ";" || c === "#") && !quoted) {
            break;
        } else if (!quoted && /\s/.test(c)) {
            if (started) pending += c;
        } else {
            emit(c);
        }
    }
    return out;
}

function formatValue(value: string): string {
    const escaped = value
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n")
        .replace(/\t/g, "\\t");
    const needsQuotes = /^\s|\s$|[;#]/.test(value) || value === "";
    return needsQuotes ? `"${escaped}"` : escaped;
}

/** Split "section.sub.section.key" into its parts (subsection may contain dots). */
function splitPath(path: string): {
    section: string;
    subsection: string | undefined;
    key: string;
} {
    const first = path.indexOf(".");
    const last = path.lastIndexOf(".");
    if (first < 0 || (first === last && last === path.length - 1)) {
        throw new Error(`Invalid config path ${path}`);
    }
    return {
        section: path.slice(0, first).toLowerCase(),
        subsection: first === last ? undefined : path.slice(first + 1, last),
        key: path.slice(last + 1).toLowerCase(),
    };
}

export class GitConfig {
    private lines: Line[] = [];

    constructor(text = "") {
        let section = "";
        let subsection: string | undefined;
        const physical = text.split(/\r?\n/);
        for (let i = 0; i < physical.length; i++) {
            let raw = physical[i]!;
            // Continuation lines end with a backslash; keep it in `raw` so
            // untouched lines are written back verbatim.
            while (raw.endsWith("\\") && i + 1 < physical.length) {
                raw = raw + "\n" + physical[++i];
            }
            const trimmed = raw.trim();
            const header =
                /^\[\s*([\w.-]+)(?:\s+"((?:[^"\\]|\\.)*)")?\s*\]/.exec(trimmed);
            if (header) {
                const name = header[1]!;
                if (header[2] !== undefined) {
                    section = name.toLowerCase();
                    subsection = header[2].replace(/\\(.)/g, "$1");
                } else if (name.includes(".")) {
                    // Deprecated [section.subsection] syntax.
                    const dot = name.indexOf(".");
                    section = name.slice(0, dot).toLowerCase();
                    subsection = name.slice(dot + 1).toLowerCase();
                } else {
                    section = name.toLowerCase();
                    subsection = undefined;
                }
                this.lines.push({ raw, section, subsection, isHeader: true });
                continue;
            }
            const variable = /^([A-Za-z][\w-]*)\s*(?:=(.*))?$/s.exec(trimmed);
            if (
                variable &&
                section &&
                !trimmed.startsWith("#") &&
                !trimmed.startsWith(";")
            ) {
                this.lines.push({
                    raw,
                    section,
                    subsection,
                    key: variable[1]!.toLowerCase(),
                    value:
                        variable[2] === undefined
                            ? "true"
                            : parseValue(variable[2].replace(/\\\n/g, "")),
                });
                continue;
            }
            this.lines.push({ raw, section, subsection });
        }
    }

    private matches(l: Line, s: string, sub: string | undefined): boolean {
        return l.section === s && l.subsection === sub;
    }

    /** The last value of `path`, as `git config --get` returns it. */
    get(path: string): string | undefined {
        return this.getAll(path).last();
    }

    getAll(path: string): string[] {
        const { section, subsection, key } = splitPath(path);
        return this.lines
            .filter(
                (l) => l.key === key && this.matches(l, section, subsection)
            )
            .map((l) => l.value!);
    }

    /** Subsection names of `section`, in file order (e.g. remote names). */
    subsections(section: string): string[] {
        section = section.toLowerCase();
        const names: string[] = [];
        for (const l of this.lines) {
            if (
                l.isHeader &&
                l.section === section &&
                l.subsection !== undefined &&
                !names.includes(l.subsection)
            ) {
                names.push(l.subsection);
            }
        }
        return names;
    }

    /** Set `path` (replacing its last occurrence), or remove all occurrences when undefined. */
    set(path: string, value: string | undefined): void {
        const { section, subsection, key } = splitPath(path);
        const isTarget = (l: Line) =>
            l.key === key && this.matches(l, section, subsection);
        if (value === undefined) {
            this.lines = this.lines.filter((l) => !isTarget(l));
            return;
        }
        const name = path.slice(path.lastIndexOf(".") + 1);
        const line: Line = {
            raw: `\t${name} = ${formatValue(value)}`,
            section,
            subsection,
            key,
            value,
        };
        let last = -1;
        this.lines.forEach((l, i) => {
            if (isTarget(l)) last = i;
        });
        if (last >= 0) {
            this.lines[last] = line;
            return;
        }
        // Append after the last line of the last matching section.
        let insertAt = -1;
        let inSection = false;
        this.lines.forEach((l, i) => {
            if (l.isHeader) inSection = this.matches(l, section, subsection);
            if (inSection) insertAt = i;
        });
        if (insertAt >= 0) {
            this.lines.splice(insertAt + 1, 0, line);
            return;
        }
        const sectionName = path.slice(0, path.indexOf("."));
        const header =
            subsection === undefined
                ? `[${sectionName}]`
                : `[${sectionName} "${subsection.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"]`;
        if (this.lines.length > 0 && this.lines.last()!.raw === "") {
            this.lines.pop();
        }
        this.lines.push(
            { raw: header, section, subsection, isHeader: true },
            line
        );
    }

    /** Remove a whole section (e.g. a remote). */
    removeSection(section: string, subsection: string | undefined): void {
        section = section.toLowerCase();
        this.lines = this.lines.filter(
            (l) => !this.matches(l, section, subsection)
        );
    }

    toString(): string {
        const text = this.lines.map((l) => l.raw).join("\n");
        return text.endsWith("\n") ? text : text + "\n";
    }
}
