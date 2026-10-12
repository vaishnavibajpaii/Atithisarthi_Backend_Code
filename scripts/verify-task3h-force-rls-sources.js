"use strict";

const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const read = (name) => fs.readFileSync(path.join(root, "backend/scripts", name), "utf8");
const preflight = read("task3h-force-rls-preflight.sql");
const migration = read("task3h-force-rls.sql");
const verification = read("task3h-force-rls-verify.sql");
const rollback = read("task3h-force-rls-rollback.sql");

function names(fragment) {
  return [...fragment.matchAll(/'([a-z][a-z0-9_]*)'/g)].map((match) => match[1]);
}

function cteArray(source, cteName) {
  const match = source.match(new RegExp(`${cteName}\\(name\\)[\\s\\S]*?array\\[([\\s\\S]*?)\\]::text\\[\\]\\)`));
  assert(match, `Missing ${cteName} manifest`);
  return names(match[1]);
}

function constantArray(source) {
  const match = source.match(/target_tables constant text\[\]:=array\[([\s\S]*?)\]\s*::text\[\]/);
  assert(match, "Missing target_tables constant manifest");
  return names(match[1]);
}

function sorted(values) {
  return [...values].sort();
}

const preflightManifest = [
  "hotels",
  ...cteArray(preflight, "managed"),
  ...cteArray(preflight, "mutable"),
  ...cteArray(preflight, "append_only")
];
const migrationManifest = constantArray(migration);
const verificationManifest = cteArray(verification, "target");
const rollbackManifest = constantArray(rollback);

for (const [label, manifest] of Object.entries({
  preflight: preflightManifest,
  migration: migrationManifest,
  verification: verificationManifest,
  rollback: rollbackManifest
})) {
  assert.equal(manifest.length, 68, `${label} manifest must contain 68 tables`);
  assert.equal(new Set(manifest).size, 68, `${label} manifest contains duplicates`);
}

assert.deepEqual(sorted(migrationManifest), sorted(preflightManifest));
assert.deepEqual(sorted(verificationManifest), sorted(preflightManifest));
assert.deepEqual(sorted(rollbackManifest), sorted(preflightManifest));
assert.match(migration, /alter table public\.%I force row level security/);
assert.doesNotMatch(migration, /\b(drop|truncate|delete|insert|update)\b/i);
assert.match(rollback, /EMERGENCY ROLLBACK ONLY/);
assert.match(rollback, /no force row level security/);
assert.match(preflight, /runtime_policy_count','199'/);
assert.match(preflight, /service_role_bypass_preserved/);
assert.match(verification, /target_tables_force_rls_enabled','68'/);
assert.match(verification, /privileged_payment_rpc_runtime_execute/);

process.stdout.write("Task 3H FORCE RLS source verification passed (68/68 identical manifests).\n");
process.stdout.write("This verifier is source-only and made no database writes.\n");
