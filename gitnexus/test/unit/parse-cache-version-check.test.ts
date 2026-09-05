/**
 * The CI guard for concurrent `SCHEMA_BUMP` claims.
 *
 * The in-repo pin (`expect(...).toBe(N)`) cannot catch this and the ledger says
 * so four separate times: both branches assert the same number, so both are
 * green while they collide. The conflict exists only in the RELATION between
 * two branches, so the check has to compare against the base — and therefore
 * has to be tested against real git state rather than mocked.
 *
 * Failure here is silent in production, which is why it kept recurring:
 * `PARSE_CACHE_VERSION` is the only invalidator for the durable ParsedFile
 * store, so a shared version means one side's parse-time change replays
 * pre-change ParsedFiles on every incremental analyze, and the graph is simply
 * missing edges.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SCRIPT = path.resolve(
  __dirname,
  '..',
  '..',
  '..',
  'scripts',
  'check-parse-cache-version.mjs',
);
const CACHE_REL = path.join('gitnexus', 'src', 'storage', 'parse-cache.ts');

let repo: string;

const git = (...args: string[]): void => {
  execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
};

const writeBump = (n: number): void => {
  const file = path.join(repo, CACHE_REL);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `// fixture\nconst SCHEMA_BUMP = ${n};\nexport {};\n`, 'utf8');
};

/** Run the check against `baseRef`, returning its exit code and stderr. */
const runCheck = (baseRef: string): { code: number; out: string } => {
  const res = spawnSync(process.execPath, [SCRIPT], {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GITNEXUS_BASE_REF: baseRef },
  });
  return { code: res.status ?? -1, out: `${res.stdout}${res.stderr}` };
};

beforeAll(() => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-cachever-'));
  git('init', '-q', '--initial-branch=main');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  writeBump(45);
  git('add', '-A');
  git('commit', '-qm', 'base at 45');
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
});

describe('check-parse-cache-version', () => {
  // The case that matters most in practice, because it is the case for almost
  // every PR — and the one this check got wrong first. Requiring a strict
  // increase unconditionally would have failed every branch that does not touch
  // the parse cache, including the branch that introduced the check.
  it('passes a branch that does not touch the parse cache at all', () => {
    // Byte-identical to base: no claim on any version, nothing to collide with.
    const { code, out } = runCheck('main');
    expect(code).toBe(0);
    expect(out).toContain('claims no version');
  });

  it('passes when the branch raises the version', () => {
    writeBump(46);
    const { code, out } = runCheck('main');
    expect(code).toBe(0);
    expect(out).toContain('OK');
  });

  // The case the pin test is blind to, and the one that has actually happened
  // four times.
  it('fails when both sides claim the same number', () => {
    // Same NUMBER but the file is modified, which is what makes it a claim.
    // (A comment change is enough — the point is that this branch is editing
    // the parse cache while leaving the version alone.)
    fs.writeFileSync(
      path.join(repo, CACHE_REL),
      `// fixture, edited\nconst SCHEMA_BUMP = 45;\nexport {};\n`,
      'utf8',
    );
    const { code, out } = runCheck('main');
    expect(code).toBe(1);
    expect(out).toContain('on BOTH this branch');
    // The message must say what to do, not just that something is wrong.
    expect(out).toContain('46 or higher');
  });

  it('fails when the version goes backwards', () => {
    writeBump(44);
    const { code, out } = runCheck('main');
    expect(code).toBe(1);
    expect(out).toMatch(/BACKWARDS/);
  });

  // A misconfigured CI checkout must not look like a pass. Exit 2 is distinct
  // from both success and a real conflict so the two cannot be confused.
  it('exits 2 — not 0 — when the base ref is unreachable', () => {
    writeBump(46);
    const { code, out } = runCheck('origin/nope');
    expect(code).toBe(2);
    expect(out).toContain('fetch-depth');
  });

  it('fails loudly if the declaration it parses ever moves', () => {
    fs.writeFileSync(
      path.join(repo, CACHE_REL),
      '// renamed away\nconst SOMETHING_ELSE = 46;\nexport {};\n',
      'utf8',
    );
    const { code, out } = runCheck('main');
    expect(code).not.toBe(0);
    expect(out).toContain('do not delete the check');
  });
});
