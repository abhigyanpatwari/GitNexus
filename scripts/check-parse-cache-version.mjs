#!/usr/bin/env node
/**
 * Fail a PR whose `SCHEMA_BUMP` is not STRICTLY GREATER than the base branch's.
 *
 * The in-repo pin test cannot catch this, and its ledger says so in four
 * separate entries: both branches assert `toBe(N)`, so the assertion is green on
 * each side while they claim the same number. The collision only exists in the
 * relationship BETWEEN the two branches, which no single-branch test can see.
 *
 * The consequence is silent, which is why it keeps recurring. `PARSE_CACHE_VERSION`
 * is the only invalidator for the durable ParsedFile store — byte-unchanged files
 * skip tree-sitter entirely — so two divergent capture schemas sharing one version
 * string means one side's parse-time change replays pre-change ParsedFiles forever.
 * Nothing throws; the graph is simply missing edges, which is the confident-empty
 * answer this repo has spent several PRs removing.
 *
 * Ten ledger entries, four of them exact clashes, every one caught by hand at
 * merge time. This is that manual step, run on every PR instead of remembered.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const BASE_REF = process.env.GITNEXUS_BASE_REF ?? 'origin/main';
const CACHE_FILE = 'gitnexus/src/storage/parse-cache.ts';
const PATTERN = /^const SCHEMA_BUMP = (\d+);/m;

/** Parse `SCHEMA_BUMP` out of a parse-cache source string. */
function readBump(source, origin) {
  const match = PATTERN.exec(source);
  if (match === null) {
    throw new Error(
      `Could not find \`const SCHEMA_BUMP = <n>;\` in ${origin}. If the declaration ` +
        `moved or was renamed, update scripts/check-parse-cache-version.mjs to match — ` +
        `do not delete the check.`,
    );
  }
  return Number(match[1]);
}

function readBaseSource() {
  try {
    return execFileSync('git', ['show', `${BASE_REF}:${CACHE_FILE}`], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return null;
  }
}

const baseSource = readBaseSource();
if (baseSource === null) {
  // A shallow clone or a missing base ref is a CI-configuration problem, not a
  // version conflict. Say so plainly rather than passing quietly (which would
  // make the check look green while testing nothing) or failing the PR for it.
  console.error(
    `parse-cache version check: could not read ${CACHE_FILE} at ${BASE_REF}.\n` +
      `Fetch the base branch before running this (actions/checkout needs ` +
      `fetch-depth: 0, or an explicit \`git fetch origin main\`).`,
  );
  process.exit(2);
}

const headSource = readFileSync(CACHE_FILE, 'utf8');
const base = readBump(baseSource, BASE_REF);
const head = readBump(headSource, 'the working tree');

// A branch that does not touch this file cannot collide with anything, and
// must not be asked to bump a version it has no reason to change. Only a branch
// that MODIFIES the parse cache is claiming a version, so only it has to prove
// the claim is unique.
//
// This is also why the check stays useful after both PRs are open: while base
// is still 45 two branches can both claim 46 and both pass, exactly as the
// ledger describes. What catches it is CI re-running once the first one merges
// and base becomes 46 — which is the "RE-CHECK AGAINST origin/main IMMEDIATELY
// BEFORE MERGING" step, now automatic instead of remembered.
if (headSource === baseSource) {
  console.log(
    `parse-cache version check: OK — ${CACHE_FILE} is unchanged from ${BASE_REF} ` +
      `(SCHEMA_BUMP ${head}), so this branch claims no version.`,
  );
  process.exit(0);
}

if (head > base) {
  console.log(`parse-cache version check: OK — SCHEMA_BUMP ${head} > ${BASE_REF} ${base}.`);
  process.exit(0);
}

const verdict =
  head === base
    ? `${CACHE_FILE} changed on this branch, but SCHEMA_BUMP is ${head} on BOTH this ` +
      `branch and ${BASE_REF}.`
    : `SCHEMA_BUMP is ${head} here but ${base} on ${BASE_REF} — it has gone BACKWARDS.`;

console.error(
  `parse-cache version check: FAILED\n\n` +
    `  ${verdict}\n\n` +
    `  Two divergent capture schemas would share one PARSE_CACHE_VERSION. The durable\n` +
    `  ParsedFile store treats that string as its only invalidator, so one side's\n` +
    `  parse-time change would replay pre-change ParsedFiles on every incremental\n` +
    `  analyze. Nothing fails; the graph is just missing edges.\n\n` +
    `  Fix: raise SCHEMA_BUMP in ${CACHE_FILE} to ${base + 1} or higher, move the pin in\n` +
    `  gitnexus/test/unit/incremental-parse-cache.test.ts to match, and add a ledger\n` +
    `  entry above the constant recording BOTH claimants.\n\n` +
    `  The pin test cannot catch this on its own: both branches assert the same\n` +
    `  number and both pass. That is why this check compares against ${BASE_REF}.`,
);
process.exit(1);
