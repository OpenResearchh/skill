#!/usr/bin/env node
import path from "node:path";
import process from "node:process";
import {
  parseArgs,
  repoCommitment,
  stellarTreeHash,
  writeJson,
} from "../../autoresearch-create/scripts/stellar_open_research.mjs";
import { assertAllowedRemote } from "./git_artifacts.mjs";

const BOOL_FLAGS = new Set(["help"]);

function usage() {
  console.log(`Usage:
  node scripts/stellar_git_ref.mjs \\
    --repo-root <path> \\
    --remote-url <url> \\
    --head-commit <sha> \\
    --base-commit <sha> \\
    --output <path>
`);
}

function main() {
  const options = parseArgs(process.argv.slice(2), BOOL_FLAGS);
  if (options.help || !options.repoRoot || !options.remoteUrl || !options.headCommit) {
    usage();
    return 0;
  }
  const remoteUrl = assertAllowedRemote(options.remoteUrl);
  const repo = repoCommitment(remoteUrl);
  const out = {
    repo: repo.canonical,
    repo_hash: repo.repoId,
    remote_url: remoteUrl,
    base_commit: options.baseCommit || null,
    head_commit: options.headCommit,
    tree_hash: stellarTreeHash(path.resolve(options.repoRoot), options.headCommit),
    hash_algo: options.headCommit.length === 64 ? 1 : 0,
  };
  if (options.output) {
    writeJson(path.resolve(options.output), out);
  } else {
    console.log(JSON.stringify(out, null, 2));
  }
  return 0;
}

try {
  process.exit(main());
} catch (err) {
  console.error(`stellar git ref failed: ${err.message}`);
  process.exit(1);
}
