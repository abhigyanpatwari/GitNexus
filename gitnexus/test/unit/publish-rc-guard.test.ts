import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Regression coverage for the rc-guard release-PR skip in
 * .github/workflows/publish.yml. The `chore: release vX.Y.Z` subject match is
 * load-bearing: it prevents an RC build firing on the release-PR commit from
 * racing the imminent stable-tag push on the same SHA (see the v1.6.4 race
 * history referenced in the workflow comments). This test pins the exact
 * regex shipped in the workflow by extracting it from the YAML and running it
 * under the same bash semantics (`shopt -s nocasematch`, anchored POSIX ERE).
 */
const REPO_ROOT = path.resolve(__dirname, '../../..');
const WORKFLOW = path.join(REPO_ROOT, '.github/workflows/publish.yml');

function releaseSubjectRegex(): string {
  const yaml = readFileSync(WORKFLOW, 'utf8');
  const match = yaml.match(/RELEASE_SUBJECT_RE='([^']+)'/);
  if (!match) {
    throw new Error(
      'RELEASE_SUBJECT_RE not found in publish.yml — did the rc-guard Decide step change?',
    );
  }
  return match[1];
}

function subjectMatches(subject: string, regex: string): boolean {
  const script = [
    'set -euo pipefail',
    'shopt -s nocasematch',
    `SUBJECT=${JSON.stringify(subject)}`,
    `REGEX=${JSON.stringify(regex)}`,
    '[[ "$SUBJECT" =~ $REGEX ]] && echo MATCH || echo NO_MATCH',
    'shopt -u nocasematch',
  ].join('\n');
  const out = execFileSync('bash', ['-c', script], { encoding: 'utf8' }).trim();
  return out === 'MATCH';
}

describe('rc-guard release-subject regex (publish.yml)', () => {
  const regex = releaseSubjectRegex();

  it('matches canonical release subjects', () => {
    expect(subjectMatches('chore: release v1.6.4', regex)).toBe(true);
    expect(subjectMatches('chore: release v10.20.30', regex)).toBe(true);
  });

  it('matches squash-merge subjects with the (#NNNN) suffix', () => {
    expect(subjectMatches('chore: release v1.6.4 (#1474)', regex)).toBe(true);
  });

  it('stays case-insensitive for IDE auto-capitalization', () => {
    expect(subjectMatches('Chore: Release v1.2.3', regex)).toBe(true);
  });

  it('does not match ordinary chore commits', () => {
    expect(subjectMatches('chore: bump deps (#1500)', regex)).toBe(false);
  });

  it('does not match release-like subjects with extra suffixes or prefixes', () => {
    expect(subjectMatches('chore: release v1.6.4 hotfix', regex)).toBe(false);
    expect(subjectMatches('revert: chore: release v1.6.4', regex)).toBe(false);
  });

  it('requires a full semver', () => {
    expect(subjectMatches('chore: release v1.6', regex)).toBe(false);
    expect(subjectMatches('chore: release v1.6.x', regex)).toBe(false);
  });
});
