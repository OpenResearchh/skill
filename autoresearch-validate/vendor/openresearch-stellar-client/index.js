export * from "./git.js";
export * from "./networks.js";
export * from "./score.js";
export * as generated from "./generated/src/index.js";
import { parseCommitId } from "./git.js";
/**
 * Settles approval before invoking an external merge callback, then records the
 * resulting commit. Merge and record failures are returned as durable partial
 * success states because the approval transaction is already settled.
 */
export async function approveMergeAndRecord(client, args, merge, options) {
    const approvalTx = await client.approve(args, options);
    throwIfContractError(approvalTx.result);
    const approval = await approvalTx.signAndSend();
    let mergedCommit;
    try {
        const merged = await merge(args.proposal_id);
        mergedCommit = typeof merged === "string" ? parseCommitId(merged) : merged;
    }
    catch (error) {
        return {
            status: "approved-but-unmerged",
            approval,
            error,
        };
    }
    try {
        const recordTx = await client.record_merge({
            verifier: args.verifier,
            proposal_id: args.proposal_id,
            merged_commit: mergedCommit,
        }, options);
        throwIfContractError(recordTx.result);
        const record = await recordTx.signAndSend();
        return {
            status: "merged-and-recorded",
            approval,
            mergedCommit,
            record,
        };
    }
    catch (error) {
        return {
            status: "approved-but-unrecorded",
            approval,
            mergedCommit,
            error,
        };
    }
}
export class OpenResearchContractError extends Error {
    code;
    constructor(code, message = `OpenResearch contract error ${code}`, options) {
        super(message, options);
        this.code = code;
        this.name = "OpenResearchContractError";
    }
}
export const contractErrorNames = {
    1: "InvalidConfig",
    2: "NotAdmin",
    3: "NotVerifier",
    4: "VerifierAlreadyExists",
    5: "VerifierNotFound",
    6: "IdentityNotFound",
    7: "InvalidHandle",
    8: "InvalidPlatform",
    100: "ProjectNotFound",
    101: "ProposalNotFound",
    102: "InvalidGitRef",
    103: "InvalidProtocolHash",
    104: "InvalidMetricScale",
    106: "InvalidImprovementBips",
    108: "InvalidAmount",
    109: "ArithmeticOverflow",
    110: "ProjectFrozen",
    111: "ProjectAlreadyFrozen",
    112: "ProtocolEpochMismatch",
    113: "NotProjectCreator",
    200: "StakeTooLow",
    201: "QueueFull",
    202: "BaseCommitMismatch",
    203: "InvalidStatus",
    204: "NotClaimOwner",
    205: "ReviewLockActive",
    206: "ProposalCannotExpire",
    208: "InsufficientImprovement",
    209: "ReviewLockExpired",
    210: "MergeAlreadyRecorded",
};
export function contractErrorName(code) {
    return contractErrorNames[code];
}
function throwIfContractError(result) {
    if (!result.isErr())
        return;
    const message = result.unwrapErr().message;
    const entry = Object.entries(contractErrorNames).find(([, name]) => message.includes(name));
    throw new OpenResearchContractError(entry === undefined ? -1 : Number(entry[0]), message);
}
