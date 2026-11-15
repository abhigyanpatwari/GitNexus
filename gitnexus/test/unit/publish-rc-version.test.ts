import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { load } from 'js-yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const workflow = load(
  readFileSync(path.resolve(__dirname, '../../../.github/workflows/publish.yml'), 'utf8'),
) as { jobs: { publish: { steps: { id?: string; run?: string }[] } } };
const versionStep = workflow.jobs.publish.steps.find((step) => step.id === 'rc-version');
if (!versionStep?.run) throw new Error('Missing RC version resolver');
const script = versionStep.run;

// Execute the workflow's actual resolver against real Git tags, with npm
// metadata held behind a completed publish as in run 39472555350.
describe.skipIf(process.platform === 'win32')('publish.yml RC version allocation', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'gitnexus-rc-version-'));
    execFileSync('git', ['init', '--quiet', dir]);
    execFileSync(
      'git',
      [
        '-c',
        'user.name=Test',
        '-c',
        'user.email=test@example.com',
        '-c',
        'commit.gpgsign=false',
        'commit',
        '--quiet',
        '--allow-empty',
        '-m',
        'fixture',
      ],
      { cwd: dir },
    );
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function resolve(versions: string[] | string, tags: string[], existingVersion = '') {
    for (const tag of tags) execFileSync('git', ['tag', tag], { cwd: dir });
    return spawnSync(
      'bash',
      [
        '-c',
        `
        npm() {
          case "$*" in
            "view gitnexus version") echo '1.6.12' ;;
            "view gitnexus versions --json") printf '%s' "$MOCK_VERSIONS" ;;
            "view gitnexus@$MOCK_EXISTING_VERSION version") echo "$MOCK_EXISTING_VERSION" ;;
            "view gitnexus@"*" version") echo 'E404 not found' >&2; return 1 ;;
            *) echo "Unexpected npm invocation: $*" >&2; return 2 ;;
          esac
        }
        npx() {
          if [ "$*" = "--yes -p semver@7 semver -i patch 1.6.12" ]; then
            echo '1.6.13'
          else
            echo "Unexpected npx invocation: $*" >&2; return 2
          fi
        }
        ${script.replaceAll('/tmp/', `${dir}/`)}
        `,
      ],
      {
        cwd: dir,
        encoding: 'utf8',
        timeout: 10_000,
        env: {
          ...process.env,
          EVENT_NAME: 'push',
          BUMP_INPUT: '',
          PKG_NAME: 'gitnexus',
          GITHUB_OUTPUT: path.join(dir, 'output'),
          MOCK_VERSIONS: JSON.stringify(versions),
          MOCK_EXISTING_VERSION: existingVersion,
        },
      },
    );
  }

  it.each([
    {
      name: 'skips an existing tag while npm is still processing its publication',
      versions: ['1.6.13-rc.135'],
      tags: ['v1.6.13-rc.136'],
      next: 137,
    },
    {
      name: 'uses the highest reserved tag across multiple pending publications',
      versions: ['1.6.13-rc.135'],
      tags: ['v1.6.13-rc.136', 'v1.6.13-rc.138'],
      next: 139,
    },
    {
      name: 'keeps npm as the floor when the registry is ahead of Git tags',
      versions: ['1.6.13-rc.139'],
      tags: ['v1.6.13-rc.136'],
      next: 140,
    },
    {
      name: 'handles a single version returned by npm',
      versions: '1.6.13-rc.135',
      tags: [],
      next: 136,
    },
    {
      name: 'starts at rc.1 when neither source reserves the selected base',
      versions: [],
      tags: ['v1.6.12-rc.999', 'v1.7.0-rc.999', 'v1.6.13-beta.999'],
      next: 1,
    },
    {
      name: 'ignores tags with a nonnumeric RC suffix',
      versions: ['1.6.13-rc.135'],
      tags: ['v1.6.13-rc.999-extra', 'v1.6.13-rc.999.1'],
      next: 136,
    },
  ])('$name', ({ versions, tags, next }) => {
    const result = resolve(versions, tags);
    expect(result.status, result.stderr).toBe(0);
    const version = `1.6.13-rc.${next}`;
    expect(readFileSync(path.join(dir, 'output'), 'utf8')).toContain(`rc_version=${version}\n`);
    // The allocated name must be available to the following tag-creation step.
    execFileSync('git', ['tag', `v${version}`], { cwd: dir });
  });

  it('still aborts when the allocated version appears in npm before publication', () => {
    const result = resolve(['1.6.13-rc.135'], ['v1.6.13-rc.136'], '1.6.13-rc.137');
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('Version 1.6.13-rc.137 already exists on npm');
  });
});
