export * from "./git.js";
export * from "./networks.js";
export * from "./score.js";
export * as generated from "./generated/src/index.js";
import type { MethodOptions } from "@stellar/stellar-sdk/contract";
import type { CommitId, Client as GeneratedClient } from "./generated/src/index.js";
export type InvocationOptions = MethodOptions;
export interface ContractResult<T> {
    isOk(): boolean;
    isErr(): boolean;
    unwrap(): T;
    unwrapErr(): {
        readonly message: string;
    };
}
export interface PreparedContractTransaction<T> {
    readonly result: ContractResult<T>;
    signAndSend(): Promise<unknown>;
}
export interface ApproveArgs {
    readonly verifier: string;
    readonly proposal_id: bigint;
    readonly verified_score: bigint;
}
export interface RecordMergeArgs {
    readonly verifier: string;
    readonly proposal_id: bigint;
    readonly merged_commit: CommitId;
}
export interface OpenResearchMergeClient {
    approve(args: ApproveArgs, options?: InvocationOptions): Promise<PreparedContractTransaction<void>>;
    record_merge(args: RecordMergeArgs, options?: InvocationOptions): Promise<PreparedContractTransaction<void>>;
}
type AssertMergeClient<T extends OpenResearchMergeClient> = T;
export type GeneratedMergeClient = AssertMergeClient<GeneratedClient>;
/**
 * Settles approval before invoking an external merge callback, then records the
 * resulting commit. Merge and record failures are returned as durable partial
 * success states because the approval transaction is already settled.
 */
export declare function approveMergeAndRecord(client: OpenResearchMergeClient, args: ApproveArgs, merge: (proposalId: bigint) => CommitId | string | Promise<CommitId | string>, options?: InvocationOptions): Promise<ApproveMergeRecordResult>;
export type ApproveMergeRecordResult = {
    readonly status: "merged-and-recorded";
    readonly approval: unknown;
    readonly mergedCommit: CommitId;
    readonly record: unknown;
} | {
    readonly status: "approved-but-unmerged";
    readonly approval: unknown;
    readonly error: unknown;
} | {
    readonly status: "approved-but-unrecorded";
    readonly approval: unknown;
    readonly mergedCommit: CommitId;
    readonly error: unknown;
};
export declare class OpenResearchContractError extends Error {
    readonly code: number;
    constructor(code: number, message?: string, options?: ErrorOptions);
}
export declare const contractErrorNames: {
    readonly 1: "InvalidConfig";
    readonly 2: "NotAdmin";
    readonly 3: "NotVerifier";
    readonly 4: "VerifierAlreadyExists";
    readonly 5: "VerifierNotFound";
    readonly 6: "IdentityNotFound";
    readonly 7: "InvalidHandle";
    readonly 8: "InvalidPlatform";
    readonly 100: "ProjectNotFound";
    readonly 101: "ProposalNotFound";
    readonly 102: "InvalidGitRef";
    readonly 103: "InvalidProtocolHash";
    readonly 104: "InvalidMetricScale";
    readonly 106: "InvalidImprovementBips";
    readonly 108: "InvalidAmount";
    readonly 109: "ArithmeticOverflow";
    readonly 110: "ProjectFrozen";
    readonly 111: "ProjectAlreadyFrozen";
    readonly 112: "ProtocolEpochMismatch";
    readonly 113: "NotProjectCreator";
    readonly 200: "StakeTooLow";
    readonly 201: "QueueFull";
    readonly 202: "BaseCommitMismatch";
    readonly 203: "InvalidStatus";
    readonly 204: "NotClaimOwner";
    readonly 205: "ReviewLockActive";
    readonly 206: "ProposalCannotExpire";
    readonly 208: "InsufficientImprovement";
    readonly 209: "ReviewLockExpired";
    readonly 210: "MergeAlreadyRecorded";
};
export declare function contractErrorName(code: number): string | undefined;
