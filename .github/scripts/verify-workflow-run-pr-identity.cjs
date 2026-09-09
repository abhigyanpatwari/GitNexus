// Resolve the open PR for a trusted workflow_run consumer.
//
// This job only runs for fork PRs. GitHub leaves workflow_run.pull_requests[]
// empty on that path, and GET /repos/{base}/commits/{sha}/pulls is also empty
// because the fork head commit is not in the base repo's commit graph. The
// authoritative lookup is GET /repos/{base}/pulls?head={owner}:{branch}&state=open
// using workflow_run.head_repository + workflow_run.head_branch (server-controlled).
//
// The current PR tip may have moved past the SHA the producer built; that is
// not an identity failure — force-with-lease against the built SHA handles it.
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

function forkHeadOwner(headRepo) {
  const slash = headRepo.indexOf('/');
  if (slash <= 0 || slash === headRepo.length - 1) {
    throw new Error(`head_repo must be owner/name (got: ${JSON.stringify(headRepo)})`);
  }
  return headRepo.slice(0, slash);
}

function allowlistMetadata(raw) {
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('metadata.json must be an object');
  }
  return {
    schema: allowlistField('schema', parsed.schema, SCHEMA_PATTERN),
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
    throw new Error('Artifact base_repo does not match $GITHUB_REPOSITORY — refusing to deliver.');
  }
  if (meta.head_ref !== authority.head_branch) {
    throw new Error(
      `Artifact head_ref (${meta.head_ref}) != workflow_run.head_branch (${authority.head_branch}) — refusing.`,
    );
  }
}

function matchOpenPullsFromForkHead(pulls, { headRepo, headBranch, baseRepo }) {
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

function resolveVerifiedPullRequest({ meta, authority, pulls }) {
  const cleanMeta = allowlistMetadata(meta);
  const cleanAuthority = allowlistAuthority(authority);
  verifyArtifactAgainstWorkflowRun(cleanMeta, cleanAuthority);

  const matched = matchOpenPullsFromForkHead(pulls, {
    headRepo: cleanAuthority.head_repo,
    headBranch: cleanAuthority.head_branch,
    baseRepo: cleanAuthority.base_repo,
  });

  if (matched.length === 0) {
    throw new Error(
      `No open PR from ${cleanAuthority.head_repo}:${cleanAuthority.head_branch} targeting ${cleanAuthority.base_repo} — refusing.`,
    );
  }

  const expected = Number(cleanMeta.pr_number);
  const chosen = matched.find((pr) => pr.number === expected);
  if (!chosen) {
    throw new Error(
      `Artifact pr_number (${cleanMeta.pr_number}) is not the open PR(s) from this fork head (${matched
        .map((pr) => pr.number)
        .join(',')}) — refusing.`,
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

function listOpenPullsByHead({ ghRepo, headOwner, headBranch, runGh }) {
  const run =
    runGh ||
    ((args) => spawnSync('gh', args, { encoding: 'utf8' }));
  const result = run([
    'api',
    '--paginate',
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
  if (!Array.isArray(parsed)) {
    throw new Error('GitHub pulls?head= lookup returned a non-array');
  }
  return parsed;
}

function main() {
  const raw = fs.readFileSync(process.env.META_PATH, 'utf8');
  const meta = allowlistMetadata(raw);
  const authority = allowlistAuthority({
    head_sha: process.env.WF_HEAD_SHA,
    head_repo: process.env.WF_HEAD_REPO,
    head_branch: process.env.WF_HEAD_BRANCH,
    base_repo: process.env.GH_REPO,
  });
  const pulls = listOpenPullsByHead({
    ghRepo: authority.base_repo,
    headOwner: forkHeadOwner(authority.head_repo),
    headBranch: authority.head_branch,
  });
  const verified = resolveVerifiedPullRequest({ meta, authority, pulls });
  if (verified.branch_moved) {
    console.log(
      `PR head moved to ${verified.current_head_sha}; delivering against built SHA ${verified.head_sha} (lease will refuse if the branch moved).`,
    );
  }
  console.log(
    `Verified identity: PR=${verified.pr_number} head_sha=${verified.head_sha} head_repo=${verified.head_repo} head_ref=${verified.head_ref}.`,
  );
  const out = process.env.GITHUB_OUTPUT;
  if (!out) {
    throw new Error('GITHUB_OUTPUT is unset');
  }
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
  SCHEMA_PATTERN,
  IDENTITY_PATTERNS,
  allowlistField,
  allowlistMetadata,
  allowlistAuthority,
  forkHeadOwner,
  verifyArtifactAgainstWorkflowRun,
  matchOpenPullsFromForkHead,
  resolveVerifiedPullRequest,
  listOpenPullsByHead,
  main,
};
