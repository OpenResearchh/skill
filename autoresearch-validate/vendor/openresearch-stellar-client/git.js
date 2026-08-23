import { Buffer } from "buffer";
const encoder = new TextEncoder();
const ZERO = Buffer.from([0]);
const VALID_MODES = new Set(["100644", "100755", "120000", "160000"]);
export async function sha256(bytes) {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", Uint8Array.from(bytes));
    return Buffer.from(digest);
}
/**
 * Returns the exact UTF-8 repository identity `host/owner/repo`. The DNS host
 * is lowercased; owner and repository case are preserved.
 */
export function normalizeRepositoryIdentity(repository) {
    if (repository.length === 0 || hasInvalidUnicode(repository)) {
        throw new TypeError("repository identity must be valid non-empty UTF-8");
    }
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(repository)) {
        return normalizeUrlRepository(repository);
    }
    const scpMatch = /^git@([^/:]+):(.+)$/.exec(repository);
    if (scpMatch) {
        return canonicalIdentity(scpMatch[1], scpMatch[2]);
    }
    if (repository.includes("@") || repository.includes(":")) {
        throw new TypeError("repository identity contains credentials or a port");
    }
    const stripped = repository.replace(/^\/+|\/+$/g, "");
    const segments = stripped.split("/");
    if (segments.length !== 3) {
        throw new TypeError("canonical repository identity must have host/owner/repo");
    }
    return canonicalIdentity(segments[0], `${segments[1]}/${segments[2]}`);
}
export async function hashRepositoryIdentity(repository) {
    return sha256(encoder.encode(normalizeRepositoryIdentity(repository)));
}
export function parseCommitId(hex) {
    if ((hex.length !== 40 && hex.length !== 64) ||
        !/^[0-9a-fA-F]+$/.test(hex)) {
        throw new TypeError("commit ID must be exactly 40 or 64 hexadecimal digits");
    }
    const digest = Buffer.from(hex, "hex");
    if (digest.every((byte) => byte === 0)) {
        throw new RangeError("commit ID must not be the zero digest");
    }
    return hex.length === 40
        ? { tag: "Sha1", values: [digest] }
        : { tag: "Sha256", values: [digest] };
}
export function formatCommitId(commit) {
    if (commit.tag !== "Sha1" && commit.tag !== "Sha256") {
        throw new TypeError("invalid commit ID variant");
    }
    const digest = commit.values[0];
    const expectedLength = commit.tag === "Sha1" ? 20 : 32;
    if (digest.length !== expectedLength ||
        digest.every((byte) => byte === 0)) {
        throw new TypeError(`invalid ${commit.tag} commit digest`);
    }
    return Buffer.from(digest).toString("hex");
}
export async function hashProtocol(bytes) {
    return sha256(bytes);
}
export function serializeCanonicalTree(entries) {
    const validated = entries.map((entry) => {
        if (!VALID_MODES.has(entry.mode)) {
            throw new TypeError(`invalid Git tree mode: ${entry.mode}`);
        }
        validateTreePath(entry.path);
        return {
            entry,
            pathBytes: Buffer.from(encoder.encode(entry.path)),
        };
    });
    validated.sort((left, right) => Buffer.compare(left.pathBytes, right.pathBytes));
    for (let index = 1; index < validated.length; index += 1) {
        if (Buffer.compare(validated[index - 1].pathBytes, validated[index].pathBytes) === 0) {
            throw new TypeError(`duplicate Git tree path: ${validated[index].entry.path}`);
        }
    }
    const chunks = [];
    for (const { entry, pathBytes } of validated) {
        const blob = Buffer.from(entry.blob);
        chunks.push(Buffer.from(`${entry.mode} `, "ascii"), pathBytes, ZERO, Buffer.from(String(blob.length), "ascii"), ZERO, blob, ZERO);
    }
    return Buffer.concat(chunks);
}
export async function hashCanonicalTree(entries) {
    return sha256(serializeCanonicalTree(entries));
}
export async function createGitRef(repository, commit, entries) {
    const parsedCommit = typeof commit === "string" ? parseCommitId(commit) : commit;
    formatCommitId(parsedCommit);
    return {
        repo: await hashRepositoryIdentity(repository),
        commit: parsedCommit,
        tree_hash: await hashCanonicalTree(entries),
    };
}
function normalizeUrlRepository(repository) {
    if (repository.includes("?") || repository.includes("#")) {
        throw new TypeError("repository URL must not contain a query or fragment");
    }
    let url;
    try {
        url = new URL(repository);
    }
    catch {
        throw new TypeError("invalid repository URL");
    }
    if (url.protocol === "https:") {
        if (url.username.length > 0 || url.password.length > 0) {
            throw new TypeError("HTTPS repository URL must not contain credentials");
        }
        if (url.port.length > 0 && url.port !== "443") {
            throw new TypeError("repository URL must not use a non-default port");
        }
    }
    else if (url.protocol === "ssh:") {
        if ((url.username.length > 0 && url.username !== "git") ||
            url.password.length > 0) {
            throw new TypeError("SSH repository credentials must be optional git@");
        }
        if (url.port.length > 0 && url.port !== "22") {
            throw new TypeError("repository URL must not use a non-default port");
        }
    }
    else {
        throw new TypeError("repository URL must use HTTPS or SSH");
    }
    let path;
    try {
        const afterScheme = repository.slice(repository.indexOf("://") + 3);
        const pathStart = afterScheme.indexOf("/");
        const rawPath = pathStart === -1 ? "" : afterScheme.slice(pathStart);
        path = decodeURIComponent(rawPath);
    }
    catch {
        throw new TypeError("repository URL path has invalid percent encoding");
    }
    return canonicalIdentity(url.hostname, path);
}
function canonicalIdentity(hostInput, pathInput) {
    const host = hostInput.toLowerCase();
    if (!isDnsHost(host)) {
        throw new TypeError("repository host must be a valid DNS host");
    }
    const path = pathInput.replace(/^\/+|\/+$/g, "");
    const segments = path.split("/");
    if (segments.length !== 2 || segments.some((segment) => segment.length === 0)) {
        throw new TypeError("repository path must contain exactly owner/repo");
    }
    const owner = segments[0];
    const repo = segments[1].endsWith(".git")
        ? segments[1].slice(0, -4)
        : segments[1];
    if (repo.length === 0 ||
        owner === "." ||
        owner === ".." ||
        repo === "." ||
        repo === ".." ||
        owner.includes("?") ||
        owner.includes("#") ||
        repo.includes("?") ||
        repo.includes("#") ||
        hasInvalidUnicode(owner) ||
        hasInvalidUnicode(repo) ||
        owner.includes("\0") ||
        repo.includes("\0")) {
        throw new TypeError("repository owner and name must be valid non-empty UTF-8");
    }
    return `${host}/${owner}/${repo}`;
}
function validateTreePath(path) {
    if (path.length === 0 || hasInvalidUnicode(path)) {
        throw new TypeError("Git tree path must be valid non-empty UTF-8");
    }
    if (path.startsWith("/")) {
        throw new TypeError("Git tree path must be relative");
    }
    if (path.includes("\0")) {
        throw new TypeError("Git tree path must not contain NUL");
    }
    const components = path.split("/");
    if (components.some((component) => component.length === 0 || component === "." || component === "..")) {
        throw new TypeError("Git tree path contains an invalid component");
    }
}
function hasInvalidUnicode(value) {
    return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value);
}
function isDnsHost(host) {
    return (host.length > 0 &&
        host.length <= 253 &&
        host.split(".").every((label) => label.length > 0 &&
            label.length <= 63 &&
            /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label)));
}
