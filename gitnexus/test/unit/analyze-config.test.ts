import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import {
  loadAnalyzeConfig,
  mergeAnalyzeOptions,
  resolveDefaultBranch,
  validateBranchName,
  sanitizeDetectedBranch,
  GitNexusRcError,
  GITNEXUS_RC_FILENAME,
  DEFAULT_BRANCH_FALLBACK,
} from '../../src/cli/analyze-config.js';
import type { AnalyzeOptions } from '../../src/cli/analyze.js';

describe('analyze-config (.gitnexusrc support, #243)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-rc-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const writeRc = (contents: string) =>
    fs.writeFile(path.join(dir, GITNEXUS_RC_FILENAME), contents);

  // ── loadAnalyzeConfig ──────────────────────────────────────────────

  it('returns undefined when no .gitnexusrc exists (the normal case)', () => {
    expect(loadAnalyzeConfig(dir)).toBeUndefined();
  });

  it('throws an actionable error on invalid JSON, naming the file', async () => {
    await writeRc('{ not valid json ');
    expect(() => loadAnalyzeConfig(dir)).toThrow(GitNexusRcError);
    try {
      loadAnalyzeConfig(dir);
    } catch (err) {
      expect((err as Error).message).toContain(GITNEXUS_RC_FILENAME);
      expect((err as Error).message).toMatch(/not valid JSON/i);
    }
  });

  it('rejects a non-object top-level value', async () => {
    await writeRc('["develop"]');
    expect(() => loadAnalyzeConfig(dir)).toThrow(/must contain a JSON object/);
  });

  it('fails closed on an unknown key (typo protection)', async () => {
    await writeRc(JSON.stringify({ defalutBranch: 'develop' }));
    expect(() => loadAnalyzeConfig(dir)).toThrow(/Unknown key "defalutBranch"/);
  });

  it('parses the flat form and maps aliases onto AnalyzeOptions', async () => {
    await writeRc(
      JSON.stringify({
        defaultBranch: 'develop',
        skipContextFiles: true,
        skipSkills: true,
        embeddings: true,
        workerTimeout: 60,
      }),
    );
    const cfg = loadAnalyzeConfig(dir);
    expect(cfg).toEqual({
      defaultBranch: 'develop',
      skipAgentsMd: true, // skipContextFiles → skipAgentsMd
      skipSkills: true,
      embeddings: true,
      workerTimeout: '60', // numeric → string (Commander contract)
    });
  });

  it('parses the nested analyze form', async () => {
    await writeRc(JSON.stringify({ analyze: { defaultBranch: 'master', skipSkills: true } }));
    expect(loadAnalyzeConfig(dir)).toEqual({ defaultBranch: 'master', skipSkills: true });
  });

  it('lets the nested analyze block override flat keys for the same option', async () => {
    await writeRc(
      JSON.stringify({
        defaultBranch: 'flat-branch',
        skipSkills: false,
        analyze: { defaultBranch: 'nested-branch', skipSkills: true },
      }),
    );
    expect(loadAnalyzeConfig(dir)).toEqual({
      defaultBranch: 'nested-branch',
      skipSkills: true,
    });
  });

  it('supports the legacy "branch" alias and the issue-comment shape', async () => {
    await writeRc(JSON.stringify({ branch: 'develop', skipAiContext: true, embeddings: false }));
    expect(loadAnalyzeConfig(dir)).toEqual({
      defaultBranch: 'develop',
      skipAgentsMd: true, // skipAiContext → skipAgentsMd
      embeddings: false,
    });
  });

  it('maps noStats onto stats (negated)', async () => {
    await writeRc(JSON.stringify({ noStats: true }));
    expect(loadAnalyzeConfig(dir)).toEqual({ stats: false });
  });

  it('rejects two aliases that configure the same option at the same level', async () => {
    await writeRc(JSON.stringify({ skipContextFiles: true, skipAgentsMd: false }));
    expect(() => loadAnalyzeConfig(dir)).toThrow(/both configure the same option/);
  });

  it('requires booleans to be booleans', async () => {
    await writeRc(JSON.stringify({ skipSkills: 'yes' }));
    expect(() => loadAnalyzeConfig(dir)).toThrow(/must be a boolean/);
  });

  it('requires the nested analyze value to be an object', async () => {
    await writeRc(JSON.stringify({ analyze: 'develop' }));
    expect(() => loadAnalyzeConfig(dir)).toThrow(/"analyze" must be a JSON object/);
  });

  it('normalizes numeric embeddings cap to a string and validates it', async () => {
    await writeRc(JSON.stringify({ embeddings: 1000 }));
    expect(loadAnalyzeConfig(dir)).toEqual({ embeddings: '1000' });

    await writeRc(JSON.stringify({ embeddings: -1 }));
    expect(() => loadAnalyzeConfig(dir)).toThrow(/non-negative integer/);
  });

  it('rejects an invalid branch string in config (control characters)', async () => {
    // Build the JSON manually so the control char survives.
    await writeRc('{"defaultBranch": "de\\u0007velop"}');
    expect(() => loadAnalyzeConfig(dir)).toThrow(/control or hidden/);
  });

  // ── validateBranchName ─────────────────────────────────────────────

  it('validateBranchName trims and accepts normal branch names', () => {
    expect(validateBranchName('  develop  ', 'src')).toBe('develop');
    expect(validateBranchName('feature/foo-bar', 'src')).toBe('feature/foo-bar');
    expect(validateBranchName('release/1.2', 'src')).toBe('release/1.2');
  });

  it('validateBranchName rejects empty, whitespace, ref-special, leading dash, and "."', () => {
    expect(() => validateBranchName('   ', 'src')).toThrow(/must not be empty/);
    expect(() => validateBranchName('foo bar', 'src')).toThrow(/whitespace/);
    expect(() => validateBranchName('foo~1', 'src')).toThrow(/not allowed in a git ref/);
    expect(() => validateBranchName('foo:bar', 'src')).toThrow(/not allowed in a git ref/);
    expect(() => validateBranchName('-foo', 'src')).toThrow(/must not start with "-"/);
    expect(() => validateBranchName('foo..bar', 'src')).toThrow(/must not contain ".."/);
  });

  it('validateBranchName rejects a newline / control character', () => {
    expect(() => validateBranchName('main\nrm -rf', 'src')).toThrow(/control or hidden|whitespace/);
  });

  it('sanitizeDetectedBranch returns undefined for junk, the name otherwise', () => {
    expect(sanitizeDetectedBranch('develop')).toBe('develop');
    expect(sanitizeDetectedBranch('with space')).toBeUndefined();
    expect(sanitizeDetectedBranch(null)).toBeUndefined();
    expect(sanitizeDetectedBranch('')).toBeUndefined();
  });

  // ── resolveDefaultBranch ───────────────────────────────────────────

  it('resolveDefaultBranch: CLI wins over config and detection', () => {
    expect(
      resolveDefaultBranch({ cliBranch: 'cli', configBranch: 'cfg', detectedBranch: 'det' }),
    ).toBe('cli');
  });

  it('resolveDefaultBranch: config wins over detection', () => {
    expect(resolveDefaultBranch({ configBranch: 'develop', detectedBranch: 'main' })).toBe(
      'develop',
    );
  });

  it('resolveDefaultBranch: auto-detected branch used when no CLI/config', () => {
    expect(resolveDefaultBranch({ detectedBranch: 'trunk' })).toBe('trunk');
  });

  it('resolveDefaultBranch: falls back to "main" with nothing available', () => {
    expect(resolveDefaultBranch({})).toBe(DEFAULT_BRANCH_FALLBACK);
    expect(resolveDefaultBranch({ detectedBranch: null })).toBe('main');
    // An unusable detected branch is ignored, not surfaced as an error.
    expect(resolveDefaultBranch({ detectedBranch: 'bad branch' })).toBe('main');
  });

  it('resolveDefaultBranch: invalid CLI branch throws (user error)', () => {
    expect(() => resolveDefaultBranch({ cliBranch: 'bad branch' })).toThrow(GitNexusRcError);
    expect(() => resolveDefaultBranch({ cliBranch: 'bad branch' })).toThrow(/--default-branch/);
  });

  // ── mergeAnalyzeOptions ────────────────────────────────────────────

  it('mergeAnalyzeOptions: returns CLI unchanged when there is no config', () => {
    const cli: AnalyzeOptions = { force: true };
    expect(mergeAnalyzeOptions(cli, undefined)).toBe(cli);
  });

  it('mergeAnalyzeOptions: config fills options the CLI left unset', () => {
    const merged = mergeAnalyzeOptions({}, { skipAgentsMd: true, workerTimeout: '60' });
    expect(merged.skipAgentsMd).toBe(true);
    expect(merged.workerTimeout).toBe('60');
  });

  it('mergeAnalyzeOptions: CLI value wins over config', () => {
    const merged = mergeAnalyzeOptions({ workerTimeout: '5' }, { workerTimeout: '60' });
    expect(merged.workerTimeout).toBe('5');
  });

  it('mergeAnalyzeOptions: an explicit CLI false overrides a config true', () => {
    const merged = mergeAnalyzeOptions({ skipSkills: false }, { skipSkills: true });
    expect(merged.skipSkills).toBe(false);
  });

  it('mergeAnalyzeOptions: config stats applies unless --no-stats was passed', () => {
    // Commander default (stats:true) with config stats:false → config wins (off).
    expect(mergeAnalyzeOptions({ stats: true }, { stats: false }).stats).toBe(false);
    // Explicit --no-stats (stats:false) is never overridden back on by config.
    expect(mergeAnalyzeOptions({ stats: false }, { stats: true }).stats).toBe(false);
    // No config stats → CLI value preserved.
    expect(mergeAnalyzeOptions({ stats: true }, { skipSkills: true }).stats).toBe(true);
  });
});
