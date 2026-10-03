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
  const out = execFileSync(BASH, ['-c', script], { encoding: 'utf8' }).trim();
  return out === 'MATCH';
}

// Probe script: only a real bash with nocasematch semantics (the behavior
// this suite pins) prints BASH_OK. A Windows PATH `bash` that is actually
// the WSL launcher exits with an error when no distribution is installed,
// so it fails this probe instead of failing six unit tests.
const BASH_PROBE = 'shopt -s nocasematch; [[ "Chore" =~ ^chore$ ]] && echo BASH_OK';

function probeBash(candidate: string): boolean {
  try {
    const out = execFileSync(candidate, ['-c', BASH_PROBE], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return out === 'BASH_OK';
  } catch {
    return false;
  }
}

// Resolve a bash executable that can actually run the nocasematch ERE
// semantics this suite extracts from publish.yml. Candidates are probed in
// order; the first one that passes the nocasematch probe wins:
//   1. GITNEXUS_TEST_BASH (explicit override for unusual installs)
//   2. on win32, Git for Windows' bash.exe — probed before the PATH entry
//      because the PATH `bash` on Windows is frequently the System32 WSL
//      launcher (both the Program Files and the per-user install)
//   3. plain `bash` from PATH (the POSIX default)
// When no candidate passes, the suite below skips with an explicit reason
// instead of failing: CONTRIBUTING lists Node.js as the prerequisite, so a
// contributor without any suitable bash is supported, not broken.
function resolveBash(): string | null {
  const candidates: string[] = [];
  const override = process.env['GITNEXUS_TEST_BASH'];
  if (override) {
    candidates.push(override);
  }
  if (process.platform === 'win32') {
    const programFiles = process.env['ProgramFiles'];
    const localAppData = process.env['LocalAppData'];
    if (programFiles) {
      candidates.push(path.join(programFiles, 'Git', 'bin', 'bash.exe'));
    }
    if (localAppData) {
      candidates.push(path.join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe'));
    }
  }
  candidates.push('bash');
  for (const candidate of candidates) {
    if (probeBash(candidate)) {
      return candidate;
    }
  }
  return null;
}

const BASH = resolveBash();

describe.skipIf(!BASH)(
  `rc-guard release-subject regex (publish.yml)${BASH ? '' : ' — skipped: no bash with nocasematch semantics found (install Git for Windows or point GITNEXUS_TEST_BASH at one)'}`,
  () => {
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
  },
);

// Runs on every platform, including machines where the suite above skips:
// proves the capability probe actually rejects an unusable candidate instead
// of silently treating every spawn failure as "bash found".
describe('rc-guard bash resolution probe', () => {
  it('rejects a candidate that cannot run the nocasematch probe', () => {
    expect(probeBash('gitnexus-definitely-not-a-shell')).toBe(false);
  });
});
