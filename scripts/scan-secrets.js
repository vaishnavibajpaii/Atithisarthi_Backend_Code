"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { scanText, validateAllowlist, decodeSource } = require("../utils/secret-scanner");
const projectRoot = path.resolve(__dirname, "../..");
const allowlistPath = path.join(projectRoot, "backend/config/secret-scan-fixtures.json");

function repositoryFiles() {
  const files = new Set();
  for (const repository of [".", "backend", "frontend"]) {
    const cwd = path.resolve(projectRoot, repository);
    const output = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    for (const relative of output.split("\0").filter(Boolean)) {
      const absolute = path.resolve(cwd, relative);
      if (!absolute.startsWith(projectRoot + path.sep) || !fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) continue;
      files.add(absolute);
    }
  }
  return [...files].sort();
}

function main() {
  const allowlist = validateAllowlist(fs.existsSync(allowlistPath) ? JSON.parse(fs.readFileSync(allowlistPath, "utf8")) : []);
  const findings = [];
  let scanned = 0;
  for (const absolute of repositoryFiles()) {
    const bytes = fs.readFileSync(absolute);
    const file = path.relative(projectRoot, absolute).replace(/\\/g, "/");
    const source = decodeSource(bytes, file);
    if (source === null) continue;
    findings.push(...scanText(source, file, allowlist));
    scanned += 1;
  }
  const result = { recordedAt: new Date().toISOString(), scope: "CURRENT_TRACKED_AND_NONIGNORED_WORKTREE_ONLY", filesScanned: scanned,
    counts: { manualReview: findings.filter((item) => item.status === "manual-review").length,
      fixtures: findings.filter((item) => item.status === "fixture-approved").length,
      placeholders: findings.filter((item) => item.status === "placeholder-example").length }, findings,
    limitations: ["Does not scan Git history, ignored local .env or deployed secrets.", "Pattern detection is not a complete entropy/data-loss prevention audit.", "Matched values are never printed; fixture approval binds exact file, detector and value hash."] };
  if (process.argv.includes("--json")) console.log(JSON.stringify(result, null, 2));
  else {
    for (const item of findings) console.log(`${item.status} ${item.detector} ${item.file}:${item.line}`);
    console.log(`Secret scan: ${scanned} files, ${result.counts.manualReview} manual-review findings, ${result.counts.fixtures} exact approved fixtures, ${result.counts.placeholders} template placeholders. Values were not printed.`);
  }
  process.exitCode = result.counts.manualReview ? 1 : 0;
}

if (require.main === module) {
  try { main(); } catch { console.error("Secret scan failed; no values printed."); process.exitCode = 1; }
}
module.exports = { repositoryFiles };
