import { Buffer } from "buffer";
import { AssembledTransaction, Client as ContractClient, ClientOptions as ContractClientOptions, MethodOptions, Result } from "@stellar/stellar-sdk/contract";
import type { u32, u64, i128, Option } from "@stellar/stellar-sdk/contract";
export * from "@stellar/stellar-sdk";
export * as contract from "@stellar/stellar-sdk/contract";
export * as rpc from "@stellar/stellar-sdk/rpc";
export interface Config {
    admin: string;
    review_lock_ledgers: u32;
}
export interface GitRef {
    commit: CommitId;
    repo: Buffer;
    tree_hash: Buffer;
}
export interface Project {
    baseline: GitRef;
    baseline_score: i128;
    creator: string;
    current_best: GitRefSlot;
    current_best_miner: Option<string>;
    current_best_score: i128;
    direction: Direction;
    frozen: boolean;
    id: u64;
    metric_scale: u32;
    min_improvement_bips: u32;
    minimum_stake: i128;
    protocol_epoch: u32;
    protocol_hash: Buffer;
    reward_per_approval: i128;
    reward_pool_balance: i128;
    token: string;
}
export type CommitId = {
    tag: "Sha1";
    values: readonly [Buffer];
} | {
    tag: "Sha256";
    values: readonly [Buffer];
};
export interface Identity {
    handle: string;
    platform: u32;
}
export interface Proposal {
    base_commit: CommitId;
    candidate: GitRef;
    claimed_score: i128;
    id: u64;
    merged_commit: CommitSlot;
    miner: string;
    project_id: u64;
    protocol_epoch: u32;
    review_lock_until: u64;
    reviewer: Option<string>;
    reward_recipient: string;
    stake: i128;
    status: ProposalStatus;
    verified_score: Option<i128>;
}
export interface Verifier {
    active: boolean;
    address: string;
    attestation: Option<Buffer>;
}
export type Direction = {
    tag: "Maximize";
    values: void;
} | {
    tag: "Minimize";
    values: void;
};
/**
 * SDK 27 cannot encode `Option<CommitId>` in a contract record.
 */
export interface CommitSlot {
    present: boolean;
    value: CommitId;
}
/**
 * SDK 27 cannot encode `Option<GitRef>` in a contract record.
 */
export interface GitRefSlot {
    present: boolean;
    value: GitRef;
}
export interface SubmitInput {
    base_commit: CommitId;
    candidate: GitRef;
    claimed_score: i128;
    project_id: u64;
    reward_recipient: string;
    stake: i128;
}
export type ProposalStatus = {
    tag: "Submitted";
    values: void;
} | {
    tag: "Claimed";
    values: void;
} | {
    tag: "Approved";
    values: void;
} | {
    tag: "Rejected";
    values: void;
} | {
    tag: "Released";
    values: void;
} | {
    tag: "Expired";
    values: void;
};
export interface CreateProjectInput {
    baseline: GitRef;
    baseline_score: i128;
    direction: Direction;
    metric_scale: u32;
    min_improvement_bips: u32;
    minimum_stake: i128;
    protocol_hash: Buffer;
    reward_per_approval: i128;
    reward_pool_funding: i128;
    token: string;
}
export declare const Errors: {
    1: {
        message: string;
    };
    2: {
        message: string;
    };
    3: {
        message: string;
    };
    4: {
        message: string;
    };
    5: {
        message: string;
    };
    6: {
        message: string;
    };
    7: {
        message: string;
    };
    8: {
        message: string;
    };
    100: {
        message: string;
    };
    101: {
        message: string;
    };
    102: {
        message: string;
    };
    103: {
        message: string;
    };
    104: {
        message: string;
    };
    106: {
        message: string;
    };
    108: {
        message: string;
    };
    109: {
        message: string;
    };
    110: {
        message: string;
    };
    111: {
        message: string;
    };
    112: {
        message: string;
    };
    113: {
        message: string;
    };
    200: {
        message: string;
    };
    201: {
        message: string;
    };
    202: {
        message: string;
    };
    203: {
        message: string;
    };
    204: {
        message: string;
    };
    205: {
        message: string;
    };
    206: {
        message: string;
    };
    208: {
        message: string;
    };
    209: {
        message: string;
    };
    210: {
        message: string;
    };
};
export type DataKey = {
    tag: "Config";
    values: void;
} | {
    tag: "NextProjectId";
    values: void;
} | {
    tag: "NextProposalId";
    values: void;
} | {
    tag: "Project";
    values: readonly [u64];
} | {
    tag: "Proposal";
    values: readonly [u64];
} | {
    tag: "Verifier";
    values: readonly [string];
} | {
    tag: "Identity";
    values: readonly [string];
} | {
    tag: "OpenQueue";
    values: readonly [u64];
};
export interface Client {
    /**
     * Construct and simulate a config transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     */
    config: (options?: MethodOptions) => Promise<AssembledTransaction<Config>>;
    /**
     * Construct and simulate a expire transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     */
    expire: ({ proposal_id }: {
        proposal_id: u64;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
    /**
     * Construct and simulate a reject transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     */
    reject: ({ verifier, proposal_id, reason_code }: {
        verifier: string;
        proposal_id: u64;
        reason_code: string;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
    /**
     * Construct and simulate a submit transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     */
    submit: ({ miner, input }: {
        miner: string;
        input: SubmitInput;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>;
    /**
     * Construct and simulate a approve transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     */
    approve: ({ verifier, proposal_id, verified_score }: {
        verifier: string;
        proposal_id: u64;
        verified_score: i128;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
    /**
     * Construct and simulate a get_project transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     */
    get_project: ({ project_id }: {
        project_id: u64;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Result<Project>>>;
    /**
     * Construct and simulate a is_verifier transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     */
    is_verifier: ({ verifier }: {
        verifier: string;
    }, options?: MethodOptions) => Promise<AssembledTransaction<boolean>>;
    /**
     * Construct and simulate a add_verifier transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     */
    add_verifier: ({ admin, verifier }: {
        admin: string;
        verifier: string;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
    /**
     * Construct and simulate a bump_project transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     */
    bump_project: ({ project_id }: {
        project_id: u64;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
    /**
     * Construct and simulate a claim_review transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     */
    claim_review: ({ verifier, proposal_id }: {
        verifier: string;
        proposal_id: u64;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
    /**
     * Construct and simulate a get_identity transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     */
    get_identity: ({ address }: {
        address: string;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Result<Identity>>>;
    /**
     * Construct and simulate a get_proposal transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     */
    get_proposal: ({ proposal_id }: {
        proposal_id: u64;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Result<Proposal>>>;
    /**
     * Construct and simulate a get_verifier transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     */
    get_verifier: ({ verifier }: {
        verifier: string;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Result<Verifier>>>;
    /**
     * Construct and simulate a record_merge transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     */
    record_merge: ({ verifier, proposal_id, merged_commit }: {
        verifier: string;
        proposal_id: u64;
        merged_commit: CommitId;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
    /**
     * Construct and simulate a link_identity transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     */
    link_identity: ({ address, handle, platform }: {
        address: string;
        handle: string;
        platform: u32;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
    /**
     * Construct and simulate a amend_protocol transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     */
    amend_protocol: ({ creator, project_id, protocol_hash, baseline, baseline_score }: {
        creator: string;
        project_id: u64;
        protocol_hash: Buffer;
        baseline: GitRef;
        baseline_score: i128;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
    /**
     * Construct and simulate a create_project transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     */
    create_project: ({ creator, input }: {
        creator: string;
        input: CreateProjectInput;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Result<u64>>>;
    /**
     * Construct and simulate a freeze_project transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     */
    freeze_project: ({ admin, project_id, reason_code }: {
        admin: string;
        project_id: u64;
        reason_code: string;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
    /**
     * Construct and simulate a release_review transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     */
    release_review: ({ verifier, proposal_id }: {
        verifier: string;
        proposal_id: u64;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
    /**
     * Construct and simulate a incumbent_score transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     */
    incumbent_score: ({ project_id }: {
        project_id: u64;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>;
    /**
     * Construct and simulate a next_project_id transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     */
    next_project_id: (options?: MethodOptions) => Promise<AssembledTransaction<u64>>;
    /**
     * Construct and simulate a remove_verifier transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     */
    remove_verifier: ({ admin, verifier }: {
        admin: string;
        verifier: string;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
    /**
     * Construct and simulate a unlink_identity transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     */
    unlink_identity: ({ address }: {
        address: string;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Result<void>>>;
    /**
     * Construct and simulate a next_proposal_id transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     */
    next_proposal_id: (options?: MethodOptions) => Promise<AssembledTransaction<u64>>;
    /**
     * Construct and simulate a get_open_proposals transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     */
    get_open_proposals: ({ project_id }: {
        project_id: u64;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Result<Array<u64>>>>;
    /**
     * Construct and simulate a improvement_threshold transaction. Returns an `AssembledTransaction` object which will have a `result` field containing the result of the simulation. If this transaction changes contract state, you will need to call `signAndSend()` on the returned object.
     */
    improvement_threshold: ({ project_id }: {
        project_id: u64;
    }, options?: MethodOptions) => Promise<AssembledTransaction<Result<i128>>>;
}
export declare class Client extends ContractClient {
    readonly options: ContractClientOptions;
    static deploy<T = Client>(
    /** Constructor/Initialization Args for the contract's `__constructor` method */
    { admin, review_lock_ledgers }: {
        admin: string;
        review_lock_ledgers: u32;
    }, 
    /** Options for initializing a Client as well as for calling a method, with extras specific to deploying. */
    options: MethodOptions & Omit<ContractClientOptions, "contractId"> & {
        /** The hash of the Wasm blob, which must already be installed on-chain. */
        wasmHash: Buffer | string;
        /** Salt used to generate the contract's ID. Passed through to {@link Operation.createCustomContract}. Default: random. */
        salt?: Buffer | Uint8Array;
        /** The format used to decode `wasmHash`, if it's provided as a string. */
        format?: "hex" | "base64";
    }): Promise<AssembledTransaction<T>>;
    constructor(options: ContractClientOptions);
    readonly fromJSON: {
        config: (json: string) => AssembledTransaction<Config>;
        expire: (json: string) => AssembledTransaction<Result<void, import("@stellar/stellar-sdk/contract").ErrorMessage>>;
        reject: (json: string) => AssembledTransaction<Result<void, import("@stellar/stellar-sdk/contract").ErrorMessage>>;
        submit: (json: string) => AssembledTransaction<Result<bigint, import("@stellar/stellar-sdk/contract").ErrorMessage>>;
        approve: (json: string) => AssembledTransaction<Result<void, import("@stellar/stellar-sdk/contract").ErrorMessage>>;
        get_project: (json: string) => AssembledTransaction<Result<Project, import("@stellar/stellar-sdk/contract").ErrorMessage>>;
        is_verifier: (json: string) => AssembledTransaction<boolean>;
        add_verifier: (json: string) => AssembledTransaction<Result<void, import("@stellar/stellar-sdk/contract").ErrorMessage>>;
        bump_project: (json: string) => AssembledTransaction<Result<void, import("@stellar/stellar-sdk/contract").ErrorMessage>>;
        claim_review: (json: string) => AssembledTransaction<Result<void, import("@stellar/stellar-sdk/contract").ErrorMessage>>;
        get_identity: (json: string) => AssembledTransaction<Result<Identity, import("@stellar/stellar-sdk/contract").ErrorMessage>>;
        get_proposal: (json: string) => AssembledTransaction<Result<Proposal, import("@stellar/stellar-sdk/contract").ErrorMessage>>;
        get_verifier: (json: string) => AssembledTransaction<Result<Verifier, import("@stellar/stellar-sdk/contract").ErrorMessage>>;
        record_merge: (json: string) => AssembledTransaction<Result<void, import("@stellar/stellar-sdk/contract").ErrorMessage>>;
        link_identity: (json: string) => AssembledTransaction<Result<void, import("@stellar/stellar-sdk/contract").ErrorMessage>>;
        amend_protocol: (json: string) => AssembledTransaction<Result<void, import("@stellar/stellar-sdk/contract").ErrorMessage>>;
        create_project: (json: string) => AssembledTransaction<Result<bigint, import("@stellar/stellar-sdk/contract").ErrorMessage>>;
        freeze_project: (json: string) => AssembledTransaction<Result<void, import("@stellar/stellar-sdk/contract").ErrorMessage>>;
        release_review: (json: string) => AssembledTransaction<Result<void, import("@stellar/stellar-sdk/contract").ErrorMessage>>;
        incumbent_score: (json: string) => AssembledTransaction<Result<bigint, import("@stellar/stellar-sdk/contract").ErrorMessage>>;
        next_project_id: (json: string) => AssembledTransaction<bigint>;
        remove_verifier: (json: string) => AssembledTransaction<Result<void, import("@stellar/stellar-sdk/contract").ErrorMessage>>;
        unlink_identity: (json: string) => AssembledTransaction<Result<void, import("@stellar/stellar-sdk/contract").ErrorMessage>>;
        next_proposal_id: (json: string) => AssembledTransaction<bigint>;
        get_open_proposals: (json: string) => AssembledTransaction<Result<bigint[], import("@stellar/stellar-sdk/contract").ErrorMessage>>;
        improvement_threshold: (json: string) => AssembledTransaction<Result<bigint, import("@stellar/stellar-sdk/contract").ErrorMessage>>;
    };
}
