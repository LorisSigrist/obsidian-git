export class GitError extends Error {
    constructor(message: string) {
        super(message);
        this.name = new.target.name;
    }
}

/** A ref, object or path that does not exist. */
export class NotFoundError extends GitError {
    constructor(readonly what: string) {
        super(`Could not find ${what}.`);
    }
}

/** The user dismissed a prompt (e.g. for credentials). */
export class UserCanceledError extends GitError {
    constructor() {
        super("The operation was canceled.");
    }
}

/** The remote refused a ref update, usually because it is not a fast-forward. */
export class PushRejectedError extends GitError {
    /** Same shape as isomorphic-git's error, which the plugin reads. */
    readonly data: { reason: string };

    /** "not-fast-forward", or the reason the remote gave. */
    constructor(readonly reason: string) {
        super(
            reason === "not-fast-forward"
                ? "Push rejected because it was not a simple fast-forward. Use 'force: true' to override."
                : `Push rejected: ${reason}`
        );
        this.data = { reason };
    }
}

/** The index has unresolved conflicts. */
export class UnmergedPathsError extends GitError {
    constructor(readonly filepaths: string[]) {
        super(
            `Modifying the index is not possible because you have unmerged files: ${filepaths.join(", ")}. Fix them up in the work tree, and then stage them before committing.`
        );
    }
}

/** A merge produced conflicts. */
export class MergeConflictError extends GitError {
    constructor(readonly filepaths: string[]) {
        super(
            `Automatic merge failed with conflicts in: ${filepaths.join(", ")}`
        );
    }
}

/** An HTTP request to the remote failed. */
export class HttpError extends GitError {
    constructor(
        readonly statusCode: number,
        readonly statusMessage: string,
        readonly response?: string
    ) {
        super(`HTTP Error: ${statusCode} ${statusMessage}`);
    }
}

/** Repository data that this implementation cannot handle. */
export class UnsupportedError extends GitError {}
