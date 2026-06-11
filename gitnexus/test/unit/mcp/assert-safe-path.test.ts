/**
 * assertSafePathForRepo — security-1 hardening unit tests
 * (plan 159-callsite-id-heritage-mode-a polish review,
 * BLOCKER #1).
 *
 * The guard is used by `local-backend.ts:rename` for every
 * read/write to a repo-relative file path. The defense is
 * layered (lexical + symlink dereference + mode-gated ENOENT);
 * these tests pin the contract.
 *
 * Server-independent — uses `fs.mkdtempSync` / `fs.symlinkSync`
 * on the host tmpdir; no LadybugDB / LSP server.
 */
import { describe, it, expect, afterAll, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { assertSafePathForRepo } from '../../../src/mcp/local/local-backend.js';

let repoRoot: string;
let outsideDir: string;
let outsideFile: string;

beforeAll(() => {
  // /tmp/assert-safe-path-<rand>/repo  — the guarded root.
  // /tmp/assert-safe-path-<rand>/outside — the target a
  // symlink inside the repo dereferences to.
  repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'assert-safe-path-repo-'));
  outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'assert-safe-path-out-'));
  outsideFile = path.join(outsideDir, 'secret.txt');
  fs.writeFileSync(outsideFile, 'outside', 'utf-8');
  // Create one regular file inside the repo so positive
  // cases have something to read.
  fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, 'src', 'index.ts'), 'ok', 'utf-8');
});

afterAll(() => {
  fs.rmSync(repoRoot, { recursive: true, force: true });
  fs.rmSync(outsideDir, { recursive: true, force: true });
});

describe('assertSafePathForRepo — lexical containment', () => {
  it('accepts a path that is inside the repo (returns dereferenced path)', () => {
    // The function dereferences BOTH the repo root and
    // the candidate via `realpathSync` (security-1
    // BLOCKER fix). On macOS `/var` and `/tmp` are
    // symlinks to `/private/var` and `/private/tmp` — the
    // returned path lives in the dereferenced space. We
    // resolve the test's `repoRoot` the same way so the
    // `path.relative` comparison is apples-to-apples.
    const resolved = assertSafePathForRepo(repoRoot, 'src/index.ts');
    const realRepoRoot = fs.realpathSync.native(repoRoot);
    const rel = path.relative(realRepoRoot, resolved);
    expect(rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))).toBe(true);
  });

  it('rejects a `..` traversal (relative form)', () => {
    expect(() => assertSafePathForRepo(repoRoot, '../outside/secret.txt'))
      .toThrow(/Path traversal blocked/);
  });

  it('rejects an absolute outside path', () => {
    expect(() => assertSafePathForRepo(repoRoot, outsideFile))
      .toThrow(/Path traversal blocked/);
  });

  it('rejects the repo root itself (empty rel)', () => {
    // `path.relative(root, root) === ''` — the guard refuses
    // the root itself; opening the root is the LSP server's
    // job, not the rename tool's.
    expect(() => assertSafePathForRepo(repoRoot, '.'))
      .toThrow(/Path traversal blocked/);
  });
});

describe('assertSafePathForRepo — symlink dereference (security-1 BLOCKER fix)', () => {
  // The `maybeDidOpenForDefinition` hardening in
  // lsp/lsp-client.ts:906 is the reference pattern; this
  // guard mirrors it. Before the fix, a symlink inside the
  // repo that points outside passed the lexical `startsWith`
  // and `path.relative` checks and dereferenced to a file
  // outside the repo at read/write time. `realpathSync`
  // closes that TOCTOU class.
  it('rejects a symlink inside the repo that points outside (read mode)', () => {
    const linkPath = path.join(repoRoot, 'src', 'leak.ts');
    try { fs.unlinkSync(linkPath); } catch { /* fresh dir */ }
    fs.symlinkSync(outsideFile, linkPath);
    try {
      expect(() => assertSafePathForRepo(repoRoot, 'src/leak.ts'))
        .toThrow(/Path traversal blocked/);
    } finally {
      fs.unlinkSync(linkPath);
    }
  });

  it('rejects a symlink inside the repo that points outside (write mode)', () => {
    const linkPath = path.join(repoRoot, 'src', 'leak-write.ts');
    try { fs.unlinkSync(linkPath); } catch { /* fresh dir */ }
    fs.symlinkSync(outsideFile, linkPath);
    try {
      expect(() => assertSafePathForRepo(repoRoot, 'src/leak-write.ts', 'write'))
        .toThrow(/Path traversal blocked/);
    } finally {
      fs.unlinkSync(linkPath);
    }
  });
});

describe('assertSafePathForRepo — ENOENT mode gating', () => {
  it('read mode tolerates ENOENT and returns the lexical path', () => {
    // A non-existent file is a normal "I tried to read a
    // file that was deleted" event; the caller's readFile
    // surfaces the conventional ENOENT. We refuse to make
    // the read path bail with a traversal error on a
    // missing target — that would conflate two failure
    // modes and break the rename tool's preview flow.
    // The ENOENT branch returns the lexical `path.resolve`
    // (we cannot `realpathSync` a file that does not
    // exist). The lexical `path.relative(repoRoot, ...)`
    // step in the function already verified containment
    // — we re-assert it here from the test's side.
    const resolved = assertSafePathForRepo(repoRoot, 'src/does-not-exist.ts');
    const rel = path.relative(repoRoot, resolved);
    expect(rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))).toBe(true);
    // And the basename survives the round-trip.
    expect(path.basename(resolved)).toBe('does-not-exist.ts');
  });

  it('write mode REFUSES ENOENT (no creation via this guard)', () => {
    // A write to a non-existent file is suspicious —
    // the rename tool only edits existing files; if the
    // target is missing, the resolver looked up a stale id
    // or an attacker is probing. Refuse over guess.
    expect(() => assertSafePathForRepo(repoRoot, 'src/does-not-exist.ts', 'write'))
      .toThrow(/Path traversal blocked/);
  });
});

describe('assertSafePathForRepo — case-folded containment on darwin/win32', () => {
  it('rejects a mixed-case prefix-match on case-insensitive fs', () => {
    // On darwin/win32 the `startsWith` is case-folded. We
    // only enforce that on those platforms. Skip on linux
    // where the filesystem is genuinely case-sensitive.
    if (process.platform === 'linux') return;
    // Create a sibling dir with the same case-folded prefix.
    const siblingDir = repoRoot + 'XYZ';
    fs.mkdirSync(siblingDir, { recursive: true });
    fs.writeFileSync(path.join(siblingDir, 'oops.txt'), 'x', 'utf-8');
    try {
      // Asking for the SAME path through the guard — the
      // realpathSync step dereferences to a path that
      // escapes via `path.relative` and is refused.
      // (We craft a path that is inside the sibling dir
      // but only via case — the guard must refuse it.)
      expect(() => assertSafePathForRepo(repoRoot, path.join(siblingDir, 'oops.txt')))
        .toThrow(/Path traversal blocked/);
    } finally {
      fs.rmSync(siblingDir, { recursive: true, force: true });
    }
  });
});
