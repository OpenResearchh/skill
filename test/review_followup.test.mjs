import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { renderSignPage } from "../autoresearch-create/scripts/local_stellar_wallet_publish.mjs";
import { extractSafeTarArchive } from "../autoresearch-validate/scripts/fetch_project_artifacts_solana.mjs";
import {
  hasCurrentBestCode,
  incumbentAggregateScore,
} from "../autoresearch-validate/scripts/run_validate_loop_solana.mjs";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ARTIFACT_RESOLVE = path.join(
  ROOT,
  "..",
  "autoresearch-validate",
  "scripts",
  "artifact_resolve.py",
);

function python(code, extraArgs = []) {
  const result = spawnSync("python3", ["-c", code, ...extraArgs], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `python exited ${result.status}`);
  }
  return result;
}

function writeTar(members, dest) {
  const specPath = dest + ".spec.json";
  fs.writeFileSync(specPath, JSON.stringify(members));
  python(
    `
import json, sys, tarfile, io
spec, dest = sys.argv[1], sys.argv[2]
members = json.loads(open(spec).read())
with tarfile.open(dest, "w") as archive:
    for member in members:
        info = tarfile.TarInfo(member["name"])
        kind = member.get("type", "file")
        if kind == "dir":
            info.type = tarfile.DIRTYPE
            info.mode = 0o755
            archive.addfile(info)
            continue
        if kind == "symlink":
            info.type = tarfile.SYMTYPE
            info.linkname = member["linkname"]
            archive.addfile(info)
            continue
        data = member.get("data", "").encode()
        info.size = len(data)
        info.mode = 0o644
        archive.addfile(info, io.BytesIO(data))
`,
    [specPath, dest],
  );
}

test("create signing page includes Freighter, Rabet, xBull, and Albedo", () => {
  const html = renderSignPage({
    networkPassphrase: "Test SDF Network ; September 2015",
    summary: { contractId: "CDEMO" },
  });
  assert.match(html, /Freighter/);
  assert.match(html, /Rabet/);
  assert.match(html, /xBull/);
  assert.match(html, /Albedo/);
  assert.match(html, /never asks for a secret key/);
});

test("genesis Solana projects use the baseline incumbent until current-best code exists", () => {
  const genesis = {
    currentBestCodeIrysId: new Uint8Array(32),
    currentBestCommit: new Uint8Array(20),
    baselineAggregateScore: 2500000n,
    currentBestAggregateScore: 0n,
  };
  assert.equal(hasCurrentBestCode(genesis), false);
  assert.equal(incumbentAggregateScore(genesis), 2500000n);

  const gitBest = {
    currentBestCodeIrysId: new Uint8Array(32),
    currentBestCommit: Buffer.from("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "hex"),
    baselineAggregateScore: 2500000n,
    currentBestAggregateScore: 2400000n,
  };
  assert.equal(hasCurrentBestCode(gitBest), true);
  assert.equal(incumbentAggregateScore(gitBest), 2400000n);
});

test("safe tar extract rejects traversal, links, and copies regular files", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arah-tar-"));
  const okTar = path.join(tmp, "ok.tar");
  const badTar = path.join(tmp, "bad.tar");
  const linkTar = path.join(tmp, "link.tar");
  const okDir = path.join(tmp, "ok");
  const badDir = path.join(tmp, "bad");
  const linkDir = path.join(tmp, "link");

  writeTar([{ name: "harness/run.sh", data: "echo ok\n" }], okTar);
  extractSafeTarArchive(okTar, okDir);
  assert.equal(fs.readFileSync(path.join(okDir, "harness/run.sh"), "utf8"), "echo ok\n");

  writeTar([{ name: "../escape.txt", data: "pwn\n" }], badTar);
  assert.throws(() => extractSafeTarArchive(badTar, badDir), /unsafe tar path/);
  assert.equal(fs.existsSync(path.join(tmp, "escape.txt")), false);

  writeTar([{ name: "link", type: "symlink", linkname: "../outside" }], linkTar);
  assert.throws(() => extractSafeTarArchive(linkTar, linkDir), /unsupported tar entry type|unsafe tar link/);
});

test("artifact_resolve extract_tarball rejects path traversal", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "arah-pytar-"));
  const tarPath = path.join(tmp, "bad.tar");
  const dest = path.join(tmp, "out");
  writeTar([{ name: "../../escape.txt", data: "pwn\n" }], tarPath);
  const result = spawnSync(
    "python3",
    [
      "-c",
      `
import sys
from pathlib import Path
sys.path.insert(0, sys.argv[1])
from artifact_resolve import extract_tarball
extract_tarball(Path(sys.argv[2]), Path(sys.argv[3]))
`,
      path.dirname(ARTIFACT_RESOLVE),
      tarPath,
      dest,
    ],
    { encoding: "utf8" },
  );
  assert.notEqual(result.status, 0, result.stdout);
  assert.match(result.stderr + result.stdout, /unsafe tar/);
  assert.equal(fs.existsSync(path.join(tmp, "escape.txt")), false);
});
