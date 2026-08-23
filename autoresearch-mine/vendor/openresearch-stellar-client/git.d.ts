import { Buffer } from "buffer";
import type { CommitId, GitRef } from "./generated/src/index.js";
export type { CommitId, GitRef };
export type GitTreeMode = "100644" | "100755" | "120000" | "160000";
export interface GitTreeEntry {
    readonly path: string;
    readonly mode: GitTreeMode;
    readonly blob: Uint8Array;
}
export declare function sha256(bytes: Uint8Array): Promise<Buffer>;
/**
 * Returns the exact UTF-8 repository identity `host/owner/repo`. The DNS host
 * is lowercased; owner and repository case are preserved.
 */
export declare function normalizeRepositoryIdentity(repository: string): string;
export declare function hashRepositoryIdentity(repository: string): Promise<Buffer>;
export declare function parseCommitId(hex: string): CommitId;
export declare function formatCommitId(commit: CommitId): string;
export declare function hashProtocol(bytes: Uint8Array): Promise<Buffer>;
export declare function serializeCanonicalTree(entries: readonly GitTreeEntry[]): Buffer;
export declare function hashCanonicalTree(entries: readonly GitTreeEntry[]): Promise<Buffer>;
export declare function createGitRef(repository: string, commit: CommitId | string, entries: readonly GitTreeEntry[]): Promise<GitRef>;
