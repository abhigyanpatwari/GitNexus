// Resolve the open PR for a trusted workflow_run consumer.
//
// Shared by commit-fork-prebuilds.yml and pr-autofix-publish.yml.
// workflow_run.pull_requests[] is empty on fork PRs, and
// GET /repos/{base}/commits/{sha}/pulls is also empty because the fork head
// commit is not in the base repo's commit graph. The authoritative lookup is
// GET /repos/{base}/pulls?head={owner}:{branch}&state=open using
// workflow_run.head_repository + workflow_run.head_branch (server-controlled).
// That same query works for same-repo PRs (owner is the base repo owner).
//
// The current PR tip may have moved past the SHA the producer built; that is
// not an identity failure — the caller decides whether to lease-push or just
// comment. Two open PRs from the same fork head (same owner:branch into this
// repo) are an identity failure: artifact pr_number is untrusted and must not
// pick among them. Set SCHEMA_PATTERN to the artifact schema allowlist
// (defaults to the tree-sitter prebuild schema).
'use strict';

const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const SCHEMA_PATTERN = /^gitnexus\.ts-prebuild\/v[0-9]+$/;
const IDENTITY_PATTERNS = {
  pr_number: /^[0-9]+$/,
  head_sha: /^[0-9a-f]{40}$/,
  head_ref: /^[A-Za-z0-9._/-]+$/,
  repo: /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/,
};

function allowlistField(key, value, pattern) {
  const text = value == null ? '' : String(value);
  if (!text || !pattern.test(text)) {
    throw new Error(`metadata.${key} failed allowlist (got: ${JSON.stringify(text)})`);
  }
  return text;
}

function headRepoOwner(headRepo) {
  const slash = headRepo.indexOf('/');
  if (slash <= 0 || slash === headRepo.length - 1) {
    throw new Error(`head_repo must be owner/name (got: ${JSON.stringify(headRepo)})`);
  }
  return headRepo.slice(0, slash);
}

function compileSchemaPattern(value) {
  if (value instanceof RegExp) return value;
  if (typeof value === 'string' && value.length > 0) {
    try {
      return new RegExp(value);
    } catch {
      throw new Error('SCHEMA_PATTERN is not a valid regular expression');
    }
  }
  return SCHEMA_PATTERN;
}

function allowlistMetadata(raw, schemaPattern) {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('metadata.json must be an object');
  }
  return {
    schema: allowlistField('schema', parsed.schema, compileSchemaPattern(schemaPattern)),
    pr_number: allowlistField('pr_number', parsed.pr_number, IDENTITY_PATTERNS.pr_number),
    head_sha: allowlistField('head_sha', parsed.head_sha, IDENTITY_PATTERNS.head_sha),
    head_ref: allowlistField('head_ref', parsed.head_ref, IDENTITY_PATTERNS.head_ref),
    head_repo: allowlistField('head_repo', parsed.head_repo, IDENTITY_PATTERNS.repo),
    base_repo: allowlistField('base_repo', parsed.base_repo, IDENTITY_PATTERNS.repo),
  };
}

function allowlistAuthority(authority) {
  return {
    head_sha: allowlistField('head_sha', authority.head_sha, IDENTITY_PATTERNS.head_sha),
    head_repo: allowlistField('head_repo', authority.head_repo, IDENTITY_PATTERNS.repo),
    head_branch: allowlistField('head_ref', authority.head_branch, IDENTITY_PATTERNS.head_ref),
    base_repo: allowlistField('base_repo', authority.base_repo, IDENTITY_PATTERNS.repo),
  };
}

function verifyArtifactAgainstWorkflowRun(meta, authority) {
  if (meta.head_sha !== authority.head_sha) {
    throw new Error(
      `Artifact head_sha (${meta.head_sha}) != workflow_run.head_sha (${authority.head_sha}) — refusing.`,
    );
  }
  if (meta.head_repo !== authority.head_repo) {
    throw new Error(
      `Artifact head_repo (${meta.head_repo}) != workflow_run.head_repository (${authority.head_repo}) — refusing.`,
    );
  }
  if (meta.base_repo !== authority.base_repo) {
    throw new Error('Artifact base_repo does not match $GITHUB_REPOSITORY — refusing.');
  }
  if (meta.head_ref !== authority.head_branch) {
    throw new Error(
      `Artifact head_ref (${meta.head_ref}) != workflow_run.head_branch (${authority.head_branch}) — refusing.`,
    );
  }
}

function matchOpenPullsByHead(pulls, { headRepo, headBranch, baseRepo }) {
  if (!Array.isArray(pulls)) {
    throw new Error('GitHub pulls?head= lookup returned a non-array');
  }
  return pulls.filter((pr) => {
    return (
      pr &&
      pr.state === 'open' &&
      Number.isInteger(pr.number) &&
      pr.head &&
      pr.head.repo &&
      pr.head.repo.full_name === headRepo &&
      pr.head.ref === headBranch &&
      pr.base &&
      pr.base.repo &&
      pr.base.repo.full_name === baseRepo
    );
  });
}

function chooseVerifiedPullRequest(cleanMeta, cleanAuthority, pulls) {
  const matched = matchOpenPullsByHead(pulls, {
    headRepo: cleanAuthority.head_repo,
    headBranch: cleanAuthority.head_branch,
    baseRepo: cleanAuthority.base_repo,
  });

  if (matched.length === 0) {
    throw new Error(
      `No open PR from ${cleanAuthority.head_repo}:${cleanAuthority.head_branch} targeting ${cleanAuthority.base_repo} — refusing.`,
    );
  }

  // Artifact pr_number is untrusted. Do not use it to pick among several open
  // PRs that share this head (same owner:branch into this repo, different
  // base branches). Fail closed unless GitHub-controlled fields leave exactly one.
  if (matched.length !== 1) {
    throw new Error(
      `Ambiguous open PRs from ${cleanAuthority.head_repo}:${cleanAuthority.head_branch} targeting ${cleanAuthority.base_repo} (${matched
        .map((pr) => pr.number)
        .join(',')}) — refusing.`,
    );
  }

  const chosen = matched[0];
  const expected = Number(cleanMeta.pr_number);
  if (chosen.number !== expected) {
    throw new Error(
      `Artifact pr_number (${cleanMeta.pr_number}) is not the open PR(s) from this fork head (${chosen.number}) — refusing.`,
    );
  }

  const currentHeadSha = typeof chosen.head.sha === 'string' ? chosen.head.sha : '';
  return {
    pr_number: String(chosen.number),
    head_ref: cleanAuthority.head_branch,
    head_sha: cleanAuthority.head_sha,
    head_repo: cleanAuthority.head_repo,
    current_head_sha: currentHeadSha,
    branch_moved: Boolean(currentHeadSha && currentHeadSha !== cleanAuthority.head_sha),
  };
}

function resolveVerifiedPullRequest({ meta, authority, pulls, schemaPattern }) {
  const cleanMeta = allowlistMetadata(meta, schemaPattern);
  const cleanAuthority = allowlistAuthority(authority);
  verifyArtifactAgainstWorkflowRun(cleanMeta, cleanAuthority);
  return chooseVerifiedPullRequest(cleanMeta, cleanAuthority, pulls);
}

function flattenGhListPages(parsed) {
  if (!Array.isArray(parsed)) {
    throw new Error('GitHub pulls?head= lookup returned a non-array');
  }
  if (parsed.length === 0) return parsed;
  if (parsed.every((page) => Array.isArray(page))) {
    return parsed.flat();
  }
  return parsed;
}

function listOpenPullsByHead({ ghRepo, headOwner, headBranch, runGh }) {
  const run = runGh || ((args) => spawnSync('gh', args, { encoding: 'utf8' }));
  const result = run([
    'api',
    '--paginate',
    '--slurp',
    '-X',
    'GET',
    `repos/${ghRepo}/pulls`,
    '-f',
    'state=open',
    '-f',
    `head=${headOwner}:${headBranch}`,
  ]);
  if (result.status !== 0) {
    const err = (result.stderr || result.stdout || '').trim();
    throw new Error(`GitHub pulls?head= lookup failed: ${err || `exit ${result.status}`}`);
  }
  const stdout = (result.stdout || '').trim();
  if (!stdout) {
    throw new Error('GitHub pulls?head= lookup returned an empty body');
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('GitHub pulls?head= lookup returned non-JSON');
  }
  return flattenGhListPages(parsed);
}

function main() {
  const out = process.env.GITHUB_OUTPUT;
  if (!out) {
    throw new Error('GITHUB_OUTPUT is unset');
  }
  const metaPath = process.env.META_PATH;
  if (!metaPath) {
    throw new Error('META_PATH is unset');
  }
  const schemaPattern = compileSchemaPattern(process.env.SCHEMA_PATTERN);
  const raw = fs.readFileSync(metaPath, 'utf8');
  const meta = allowlistMetadata(raw, schemaPattern);
  const authority = allowlistAuthority({
    head_sha: process.env.WF_HEAD_SHA,
    head_repo: process.env.WF_HEAD_REPO,
    head_branch: process.env.WF_HEAD_BRANCH,
    base_repo: process.env.GH_REPO,
  });
  verifyArtifactAgainstWorkflowRun(meta, authority);
  const pulls = listOpenPullsByHead({
    ghRepo: authority.base_repo,
    headOwner: headRepoOwner(authority.head_repo),
    headBranch: authority.head_branch,
  });
  const verified = chooseVerifiedPullRequest(meta, authority, pulls);
  if (verified.branch_moved) {
    console.log(
      `PR head moved to ${verified.current_head_sha}; delivering against built SHA ${verified.head_sha}.`,
    );
  }
  console.log(
    `Verified identity: PR=${verified.pr_number} head_sha=${verified.head_sha} head_repo=${verified.head_repo} head_ref=${verified.head_ref}.`,
  );
  fs.appendFileSync(
    out,
    [
      `pr_number=${verified.pr_number}`,
      `head_ref=${verified.head_ref}`,
      `head_sha=${verified.head_sha}`,
      `head_repo=${verified.head_repo}`,
    ].join('\n') + '\n',
  );
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error(`::error::${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

module.exports = {
  IDENTITY_PATTERNS,
  allowlistField,
  headRepoOwner,
  resolveVerifiedPullRequest,
  listOpenPullsByHead,
};
