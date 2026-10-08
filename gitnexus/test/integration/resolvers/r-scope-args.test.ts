/**
 * R: the scope query picks the argument that names an import or an S4 class.
 * `library(lib.loc = libO, pkgP)` imports `pkgP` (not `libO`), a comment before
 * the first argument does not hide it, and `package =` / `file =` / `Class =` still
 * name theirs. Runs through the real pipeline (worker pool and scope resolution),
 * each negative paired with a positive control for the same call.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import path from 'path';
import { FIXTURES, getRelationships, runPipelineFromRepo } from './helpers.js';
import type { PipelineResult } from './helpers.js';

describe('R scope query: naming argument of imports and S4 classes', () => {
  let result: PipelineResult;

  beforeAll(async () => {
    result = await runPipelineFromRepo(path.join(FIXTURES, 'r-scope-args'), () => {});
  }, 60000);

  /** Sorted unique IMPORTS target files of `sourceFile` (fixture-root-relative). */
  const importTargets = (sourceFile: string): string[] =>
    [
      ...new Set(
        getRelationships(result, 'IMPORTS')
          .filter((e) => e.sourceFilePath === sourceFile)
          .map((e) => e.targetFilePath),
      ),
    ].sort();

  describe('library()', () => {
    it('imports the package named by the first argument (positive control)', () => {
      expect(importTargets('scripts/lib_positive.R')).toEqual(['pkgP/R/p.R']);
    });

    it('imports the package named by package =', () => {
      expect(importTargets('scripts/lib_package_formal.R')).toEqual(['pkgP/R/p.R']);
    });

    it('does not import a named-first argument such as lib.loc =', () => {
      expect(importTargets('scripts/lib_named_first.R')).toEqual(['pkgP/R/p.R']);
    });

    it('imports the package when a comment precedes the first argument', () => {
      expect(importTargets('scripts/lib_comment_first.R')).toEqual(['pkgP/R/p.R']);
    });
  });

  describe('backticked and quoted formals', () => {
    it('imports the package named by a backticked package =', () => {
      expect(importTargets('scripts/lib_backtick_formal.R')).toEqual(['pkgP/R/p.R']);
    });

    it('imports the file named by a quoted file =', () => {
      expect(importTargets('scripts/source_quoted_formal.R')).toEqual(['scripts/q.R']);
    });

    it('keeps the Class node and its EXTENDS edges for a backticked or quoted Class =', () => {
      const extends_ = getRelationships(result, 'EXTENDS');
      expect(extends_.some((e) => e.source === 'BacktickChild' && e.target === 'Base')).toBe(true);
      expect(extends_.some((e) => e.source === 'QuotedChild' && e.target === 'VIRTUAL')).toBe(true);
    });
  });

  describe('source()', () => {
    it('imports the file named by the first argument (positive control)', () => {
      expect(importTargets('scripts/source_positive.R')).toEqual(['scripts/q.R']);
    });

    it('imports the file named by file =', () => {
      expect(importTargets('scripts/source_file_formal.R')).toEqual(['scripts/q.R']);
    });

    it('imports the first unnamed argument after a named one such as local =', () => {
      expect(importTargets('scripts/source_named_first.R')).toEqual(['scripts/q.R']);
    });

    it('imports the file when a comment precedes the first argument', () => {
      expect(importTargets('scripts/source_comment_first.R')).toEqual(['scripts/q.R']);
    });
  });

  describe('setClass() heritage', () => {
    const extendsEdge = (source: string, target: string) =>
      getRelationships(result, 'EXTENDS').some((e) => e.source === source && e.target === target);

    it('links a class to VIRTUAL (positive control)', () => {
      expect(extendsEdge('PlainVirtual', 'VIRTUAL')).toBe(true);
    });

    it('links a class to VIRTUAL when a comment precedes the class name', () => {
      expect(extendsEdge('CommentVirtual', 'VIRTUAL')).toBe(true);
    });

    it('links a class to its base when a comment precedes the class name', () => {
      expect(extendsEdge('CommentChild', 'Base')).toBe(true);
    });

    it('links a class declared with Class = after a named contains =', () => {
      expect(extendsEdge('NamedFirstChild', 'Base')).toBe(true);
    });

    it('declares the base class once (contains = names no class)', () => {
      const bases: string[] = [];
      result.graph.forEachNode((n) => {
        if (n.label === 'Class' && n.properties.name === 'Base') bases.push(n.id);
      });
      expect(bases).toEqual(['Class:R/classes.R:Base']);
    });
  });
});
