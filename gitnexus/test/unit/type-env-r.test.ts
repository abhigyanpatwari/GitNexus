import { describe, it, expect } from 'vitest';
import { buildTypeEnv } from '../../src/core/ingestion/type-env.js';
import {
  typeConfig as rTypeConfig,
  extractReturnType as rExtractReturnType,
} from '../../src/core/ingestion/type-extractors/r.js';
import Parser from 'tree-sitter';
import R from '@eagleoutice/tree-sitter-r';

const parser = new Parser();

const parse = (code: string) => {
  parser.setLanguage(R);
  return parser.parse(code);
};

function flatGet(typeEnv: ReturnType<typeof buildTypeEnv>, varName: string): string | undefined {
  for (const [, scopeMap] of typeEnv.allScopes()) {
    const val = scopeMap.get(varName);
    if (val) return val;
  }
  return undefined;
}

function flatSize(typeEnv: ReturnType<typeof buildTypeEnv>): number {
  let count = 0;
  for (const [, scopeMap] of typeEnv.allScopes()) count += scopeMap.size;
  return count;
}

describe('buildTypeEnv', () => {
  describe('R roxygen2 annotations', () => {
    it('extracts @param type bindings from roxygen2 comments', () => {
      const tree = parse(`
#' @param data DataFrame the input data
#' @param outliers DataFrame outlier records
AddOutlierStatuses <- function(data, outliers) {
  data
}
`);
      const typeEnv = buildTypeEnv(tree, 'r');
      expect(flatGet(typeEnv, 'data')).toBe('DataFrame');
      expect(flatGet(typeEnv, 'outliers')).toBe('DataFrame');
    });

    it('skips lowercase type names (primitive types)', () => {
      const tree = parse(`
#' @param x numeric input value
#' @param name Character the name
process <- function(x, name) {
  x
}
`);
      const typeEnv = buildTypeEnv(tree, 'r');
      expect(flatGet(typeEnv, 'x')).toBeUndefined();
      expect(flatGet(typeEnv, 'name')).toBe('Character');
    });

    it('extracts no types when no roxygen2 comments present', () => {
      const tree = parse(`
process <- function(x, y) {
  x + y
}
`);
      const typeEnv = buildTypeEnv(tree, 'r');
      expect(flatSize(typeEnv)).toBe(0);
    });

    it('extracts types from = assignment function definitions', () => {
      const tree = parse(`
#' @param repo UserRepo the repository
helper = function(repo) {
  repo
}
`);
      const typeEnv = buildTypeEnv(tree, 'r');
      expect(flatGet(typeEnv, 'repo')).toBe('UserRepo');
    });

    it('returns constructor binding for R6 obj <- ClassName$new()', () => {
      const tree = parse(`
rs <- ResultSet$new(items)
`);
      const { constructorBindings } = buildTypeEnv(tree, 'r');
      const binding = constructorBindings.find((b) => b.varName === 'rs');
      expect(binding).toBeDefined();
      expect(binding!.calleeName).toBe('ResultSet');
    });

    it('extractReturnType extracts @return type from roxygen2 comment', () => {
      const tree = parse(`
#' @param name Character the user name
#' @return User
create <- function(name) {
  name
}
`);
      let defNode: any = null;
      for (let i = 0; i < tree.rootNode.childCount; i++) {
        const child = tree.rootNode.child(i);
        if (child?.type === 'binary_operator') {
          defNode = child;
          break;
        }
      }
      expect(defNode).not.toBeNull();
      const returnType = rExtractReturnType(defNode);
      expect(returnType).toBe('User');
    });

    it('extractReturnType skips lowercase @return types', () => {
      const tree = parse(`
#' @return numeric
compute <- function() { 42 }
`);
      let defNode: any = null;
      for (let i = 0; i < tree.rootNode.childCount; i++) {
        const child = tree.rootNode.child(i);
        if (child?.type === 'binary_operator') {
          defNode = child;
          break;
        }
      }
      expect(defNode).not.toBeNull();
      const returnType = rExtractReturnType(defNode);
      expect(returnType).toBeUndefined();
    });

    it('returns constructor binding for S4 obj <- new("ClassName")', () => {
      const tree = parse(`
model <- new("DataModel", name = "test")
`);
      const { constructorBindings } = buildTypeEnv(tree, 'r');
      const binding = constructorBindings.find((b) => b.varName === 'model');
      expect(binding).toBeDefined();
      expect(binding!.calleeName).toBe('DataModel');
    });

    it('extracts @param types when @examples block is present', () => {
      const tree = parse(`
#' @param data DataFrame the input data
#' @param config Config configuration object
#' @return Result
#' @examples
#' result <- process(my_data, my_config)
#' print(result)
process <- function(data, config) {
  data
}
`);
      const typeEnv = buildTypeEnv(tree, 'r');
      expect(flatGet(typeEnv, 'data')).toBe('DataFrame');
      expect(flatGet(typeEnv, 'config')).toBe('Config');
    });

    it('extracts @param types when regular comments appear before function', () => {
      const tree = parse(`
#' @param x DataFrame the input
# TODO: refactor this later
compute <- function(x) { x }
`);
      const typeEnv = buildTypeEnv(tree, 'r');
      expect(flatGet(typeEnv, 'x')).toBe('DataFrame');
    });
  });
});
