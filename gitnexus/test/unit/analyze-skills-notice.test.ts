import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

/**
 * Contract tests for analyze stale-skills notice.
 * These verify that analyze exports and uses checkStaleProjectSkills().
 */

async function getCheckStaleProjectSkills(): Promise<(repoPath: string) => Promise<boolean>> {
  const analyzeModule = await import('../../src/cli/analyze.js');
  const candidate = (analyzeModule as any).checkStaleProjectSkills;
  expect(
    typeof candidate,
    'analyze.ts must export checkStaleProjectSkills(repoPath) for unit testing',
  ).toBe('function');
  return candidate as (repoPath: string) => Promise<boolean>;
}

describe('analyze — stale project-local skills notice', () => {
  let tmpDir: string;
  let consoleOutput: string[];

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-analyze-notice-test-'));
    consoleOutput = [];
    vi.spyOn(console, 'log').mockImplementation((...args: any[]) => {
      consoleOutput.push(args.map(String).join(' '));
    });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  });

  it('prints deprecation notice when .claude/skills/gitnexus/ exists', async () => {
    const skillSubDir = path.join(tmpDir, '.claude', 'skills', 'gitnexus', 'gitnexus-exploring');
    await fs.mkdir(skillSubDir, { recursive: true });
    await fs.writeFile(path.join(skillSubDir, 'SKILL.md'), 'stale');

    const checkStaleProjectSkills = await getCheckStaleProjectSkills();
    const detected = await checkStaleProjectSkills(tmpDir);

    expect(detected).toBe(true);
    const notice = consoleOutput.find((line) => line.includes('no longer installed by analyze'));
    expect(notice).toBeDefined();
  });

  it('prints no notice when .claude/skills/gitnexus/ does not exist', async () => {
    const checkStaleProjectSkills = await getCheckStaleProjectSkills();
    const detected = await checkStaleProjectSkills(tmpDir);

    expect(detected).toBe(false);
    const notice = consoleOutput.find((line) => line.includes('no longer installed by analyze'));
    expect(notice).toBeUndefined();
  });

  it('does NOT delete the directory — only warns', async () => {
    const skillsDir = path.join(tmpDir, '.claude', 'skills', 'gitnexus');
    await fs.mkdir(skillsDir, { recursive: true });

    const checkStaleProjectSkills = await getCheckStaleProjectSkills();
    await checkStaleProjectSkills(tmpDir);

    // Directory must still exist
    const stat = await fs.stat(skillsDir);
    expect(stat.isDirectory()).toBe(true);
  });

  it('handles .claude dir existing without skills/gitnexus/', async () => {
    await fs.mkdir(path.join(tmpDir, '.claude'), { recursive: true });

    const checkStaleProjectSkills = await getCheckStaleProjectSkills();
    const detected = await checkStaleProjectSkills(tmpDir);
    expect(detected).toBe(false);
  });
});
