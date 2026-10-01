import { describe, it, expect } from 'vitest';
import { buildTypeEnv } from '../../src/core/ingestion/type-env.js';
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

/**
 * Identifiers named `varName` in the body of the function assigned to `fnName`
 * (not in its formals, and not inside a function nested in it): the nodes a
 * receiver lookup starts from.
 */
function bodyIdentifiers(tree: ReturnType<typeof parse>, fnName: string, varName: string) {
  const fnNode = tree.rootNode
    .descendantsOfType('binary_operator')
    .find((n) => n.childForFieldName('lhs')?.text === fnName)
    ?.childForFieldName('rhs');
  if (fnNode?.type !== 'function_definition') throw new Error(`no function ${fnName}`);
  return fnNode.descendantsOfType('identifier').filter((id) => {
    if (id.text !== varName) return false;
    let current = id.parent;
    while (current && current.id !== fnNode.id) {
      if (current.type === 'parameters' || current.type === 'function_definition') return false;
      current = current.parent;
    }
    return true;
  });
}

function lookupIn(
  tree: ReturnType<typeof parse>,
  typeEnv: ReturnType<typeof buildTypeEnv>,
  fnName: string,
  varName: string,
): string | undefined {
  const [node] = bodyIdentifiers(tree, fnName, varName);
  if (!node) throw new Error(`no ${varName} in ${fnName}`);
  return typeEnv.lookup(varName, node);
}

describe('buildTypeEnv', () => {
  describe('R roxygen2 annotations', () => {
    it('extracts @param type bindings from roxygen2 comments', () => {
      const tree = parse(`
DataFrame <- R6::R6Class("DataFrame", public = list(rows = function() 1))

#' @param data DataFrame
#' @param outliers DataFrame
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
#' @param x numeric
#' @param name Character
process <- function(x, name) {
  x
}
`);
      const typeEnv = buildTypeEnv(tree, 'r');
      expect(flatGet(typeEnv, 'x')).toBeUndefined();
      expect(flatGet(typeEnv, 'name')).toBeUndefined();
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

    it.each([
      ['<-', 'helper <- function(repo) {\n  repo\n}'],
      ['=', 'helper = function(repo) {\n  repo\n}'],
      ['<<-', 'helper <<- function(repo) {\n  repo\n}'],
    ])('extracts types from %s function definitions', (_op, definition) => {
      const tree = parse(`
UserRepo <- R6::R6Class("UserRepo", public = list(save = function() 1))

#' @param repo UserRepo
${definition}
`);
      const typeEnv = buildTypeEnv(tree, 'r');
      expect(flatGet(typeEnv, 'repo')).toBe('UserRepo');
      expect(lookupIn(tree, typeEnv, 'helper', 'repo')).toBe('UserRepo');
      expect(typeEnv.fileScope().get('repo')).toBeUndefined();
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
DataFrame <- R6::R6Class("DataFrame", public = list(rows = function() 1))
Config <- R6::R6Class("Config", public = list(get = function() 1))

#' @param data DataFrame
#' @param config {Config} configuration object
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
DataFrame <- R6::R6Class("DataFrame", public = list(rows = function() 1))

#' @param x DataFrame
# TODO: refactor this later
compute <- function(x) { x }
`);
      const typeEnv = buildTypeEnv(tree, 'r');
      expect(flatGet(typeEnv, 'x')).toBe('DataFrame');
    });

    it('binds a parameter only when the tag names a class the file defines', () => {
      const tree = parse(`
#' @param data DataFrame
#' @param name Character
process <- function(data, name) {
  data
}
`);
      const typeEnv = buildTypeEnv(tree, 'r');
      expect(flatGet(typeEnv, 'data')).toBeUndefined();
      expect(flatGet(typeEnv, 'name')).toBeUndefined();
    });

    it('does not bind a lowercase word even when the file defines a class of that name', () => {
      const tree = parse(`
setClass("repo", representation(name = "character"))

#' @param r repo
save <- function(r) { r }
`);
      const typeEnv = buildTypeEnv(tree, 'r');
      expect(flatGet(typeEnv, 'r')).toBeUndefined();
    });

    describe('description prose is not a type', () => {
      it.each([
        ['R6', 'Data', 'df', 'Data frame of observations', 'Data <- R6::R6Class("Data")'],
        ['S4', 'Data', 'df', 'Data frame of observations', 'setClass("Data", representation())'],
        ['R6', 'Config', 'cfg', 'Config object to read from', 'Config <- R6::R6Class("Config")'],
        [
          'S4',
          'Config',
          'cfg',
          'Config object to read from',
          'setClass("Config", representation())',
        ],
      ])(
        'does not bind the first word of a description that names a %s class %s',
        (_kind, _className, param, description, definition) => {
          const tree = parse(`
${definition}

#' @param ${param} ${description}
run <- function(${param}) {
  ${param}
}
`);
          const typeEnv = buildTypeEnv(tree, 'r');
          expect(flatGet(typeEnv, param)).toBeUndefined();
        },
      );

      it('does not bind an article or determiner that happens to be a class name', () => {
        const tree = parse(`
A <- R6::R6Class("A", public = list(go = function() 1))

#' @param x A numeric vector
f <- function(x) { x }
`);
        const typeEnv = buildTypeEnv(tree, 'r');
        expect(flatGet(typeEnv, 'x')).toBeUndefined();
      });

      it('does not bind from the first line of a description that continues on the next line', () => {
        const tree = parse(`
Data <- R6::R6Class("Data", public = list(fit = function() 1))

#' @param df Data
#'   frame of observations
run <- function(df) {
  df$fit()
}
`);
        const typeEnv = buildTypeEnv(tree, 'r');
        expect(flatGet(typeEnv, 'df')).toBeUndefined();
      });

      it('binds a braced type whose prose continues on the next line', () => {
        const tree = parse(`
Data <- R6::R6Class("Data", public = list(fit = function() 1))

#' @param df {Data} the observations,
#'   one row per case
run <- function(df) {
  df$fit()
}
`);
        const typeEnv = buildTypeEnv(tree, 'r');
        expect(flatGet(typeEnv, 'df')).toBe('Data');
      });
    });

    it('reads a tag only at the start of a roxygen line', () => {
      const tree = parse(`
UserRepo <- R6::R6Class("UserRepo", public = list(save = function() 1))

#' Write the tag as #' @param repo UserRepo in your own comments.
save <- function(repo) {
  repo
}
`);
      const typeEnv = buildTypeEnv(tree, 'r');
      expect(flatGet(typeEnv, 'repo')).toBeUndefined();
    });

    it('does not read a tag written mid-line, even when it names a defined class', () => {
      const tree = parse(`
UserRepo <- R6::R6Class("UserRepo", public = list(save = function() 1))

#' Write the tag as @param repo UserRepo
save <- function(repo) {
  repo
}
`);
      const typeEnv = buildTypeEnv(tree, 'r');
      expect(flatGet(typeEnv, 'repo')).toBeUndefined();
    });

    it('does not read a longer tag name that starts with param', () => {
      const tree = parse(`
UserRepo <- R6::R6Class("UserRepo", public = list(save = function() 1))

#' @paramfoo repo UserRepo
save <- function(repo) {
  repo
}
`);
      const typeEnv = buildTypeEnv(tree, 'r');
      expect(flatGet(typeEnv, 'repo')).toBeUndefined();
    });

    describe('the binding belongs to the documented function', () => {
      const userRepo = 'UserRepo <- R6::R6Class("UserRepo", public = list(save = function() 1))';

      it('does not bind a name that is not a formal of the documented function', () => {
        const tree = parse(`
${userRepo}

#' @param repo UserRepo
f <- function(x) { x }

g <- function(repo) { repo$save() }

h <- function() {
  repo <- 1
  repo$save()
}
`);
        const typeEnv = buildTypeEnv(tree, 'r');
        expect(lookupIn(tree, typeEnv, 'f', 'x')).toBeUndefined();
        expect(lookupIn(tree, typeEnv, 'g', 'repo')).toBeUndefined();
        expect(lookupIn(tree, typeEnv, 'h', 'repo')).toBeUndefined();
        expect(typeEnv.fileScope().get('repo')).toBeUndefined();
        expect(flatGet(typeEnv, 'repo')).toBeUndefined();
      });

      it('binds a documented formal inside its function only', () => {
        const tree = parse(`
${userRepo}

#' @param repo UserRepo
f <- function(repo) { repo$save() }

g <- function(repo) { repo$save() }

h <- function() {
  repo <- 1
  repo$save()
}
`);
        const typeEnv = buildTypeEnv(tree, 'r');
        expect(lookupIn(tree, typeEnv, 'f', 'repo')).toBe('UserRepo');
        expect(lookupIn(tree, typeEnv, 'g', 'repo')).toBeUndefined();
        expect(lookupIn(tree, typeEnv, 'h', 'repo')).toBeUndefined();
        expect(typeEnv.fileScope().get('repo')).toBeUndefined();
      });

      it('binds a formal that has a default value', () => {
        const tree = parse(`
${userRepo}

#' @param repo UserRepo
f <- function(x, repo = NULL) { repo$save() }

g <- function(repo) { repo$save() }
`);
        const typeEnv = buildTypeEnv(tree, 'r');
        expect(lookupIn(tree, typeEnv, 'f', 'repo')).toBe('UserRepo');
        expect(lookupIn(tree, typeEnv, 'g', 'repo')).toBeUndefined();
        expect(typeEnv.fileScope().get('repo')).toBeUndefined();
      });

      it('skips the dots formal and still binds a named formal beside it', () => {
        const tree = parse(`
${userRepo}

#' @param ... UserRepo
#' @param repo UserRepo
f <- function(..., repo) { repo$save() }
`);
        const typeEnv = buildTypeEnv(tree, 'r');
        expect(lookupIn(tree, typeEnv, 'f', 'repo')).toBe('UserRepo');
        expect(flatGet(typeEnv, '...')).toBeUndefined();
        expect(typeEnv.fileScope().get('repo')).toBeUndefined();
      });

      it.each([
        ['a plain value', 'repo <- 1'],
        ['a call', 'setup()'],
      ])('binds nothing when the block is followed by %s (guard)', (_label, statement) => {
        const tree = parse(`
${userRepo}

#' @param repo UserRepo
${statement}

g <- function(repo) { repo$save() }
`);
        const typeEnv = buildTypeEnv(tree, 'r');
        expect(lookupIn(tree, typeEnv, 'g', 'repo')).toBeUndefined();
        expect(typeEnv.fileScope().get('repo')).toBeUndefined();
      });

      it('does not carry an outer function documentation into a function nested in it', () => {
        const tree = parse(`
${userRepo}

#' @param repo UserRepo
outer <- function(repo) {
  inner <- function(repo) { repo$save() }
  repo$save()
}
`);
        const typeEnv = buildTypeEnv(tree, 'r');
        expect(lookupIn(tree, typeEnv, 'outer', 'repo')).toBe('UserRepo');
        expect(lookupIn(tree, typeEnv, 'inner', 'repo')).toBeUndefined();
      });

      it('binds a documented nested function only inside itself', () => {
        const tree = parse(`
Data <- R6::R6Class("Data", public = list(fit = function() 1))

outer <- function(x) {
  #' @param y Data
  inner <- function(y) { y$fit() }
  y
}
`);
        const typeEnv = buildTypeEnv(tree, 'r');
        expect(lookupIn(tree, typeEnv, 'inner', 'y')).toBe('Data');
        expect(lookupIn(tree, typeEnv, 'outer', 'y')).toBeUndefined();
        expect(typeEnv.fileScope().get('y')).toBeUndefined();
      });
    });

    describe('class definition forms', () => {
      it.each([
        ['bare R6Class', 'UserRepo <- R6Class("UserRepo", public = list(save = function() 1))'],
        [
          'namespaced R6::R6Class',
          'UserRepo <- R6::R6Class("UserRepo", public = list(save = function() 1))',
        ],
        ['setClass', 'setClass("UserRepo", representation(name = "character"))'],
        ['setRefClass', 'setRefClass("UserRepo", fields = list(name = "character"))'],
      ])('binds a type defined with %s', (_form, definition) => {
        const tree = parse(`
#' @param repo UserRepo
save <- function(repo) {
  repo
}

${definition}
`);
        const typeEnv = buildTypeEnv(tree, 'r');
        expect(flatGet(typeEnv, 'repo')).toBe('UserRepo');
      });

      it('binds the braced form, with or without prose after it', () => {
        const tree = parse(`
UserRepo <- R6::R6Class("UserRepo", public = list(save = function() 1))

#' @param repo {UserRepo} the repository
#' @param backup {UserRepo}
save <- function(repo, backup) {
  repo
}
`);
        const typeEnv = buildTypeEnv(tree, 'r');
        expect(flatGet(typeEnv, 'repo')).toBe('UserRepo');
        expect(flatGet(typeEnv, 'backup')).toBe('UserRepo');
      });
    });

    describe('forms that are not bound (guards)', () => {
      it.each([
        ['\\code{Data} markup', "#' @param df \\code{Data}", ['df']],
        ['\\linkS4class{Data} markup', "#' @param df \\linkS4class{Data}", ['df']],
        ['a comma-separated name list', "#' @param x,y Data", ['x', 'y']],
        ['the dots parameter', "#' @param ... Data", ['...']],
        ['a dotted parameter name', "#' @param na.rm Data", ['na.rm']],
      ])('does not bind %s', (_label, tag, names) => {
        const tree = parse(`
Data <- R6::R6Class("Data", public = list(fit = function() 1))

${tag}
run <- function(x, y, df, ..., na.rm = FALSE) {
  x
}
`);
        const typeEnv = buildTypeEnv(tree, 'r');
        for (const name of names) expect(flatGet(typeEnv, name)).toBeUndefined();
      });
    });
  });
});
