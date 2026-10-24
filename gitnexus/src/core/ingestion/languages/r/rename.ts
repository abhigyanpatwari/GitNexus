import type Parser from 'tree-sitter';
import type { NameClaim } from 'gitnexus-shared';
import type { RenameIssue, RenameProvider } from '../../rename-provider.js';
import { unescapeRString } from './export-pattern.js';
import { rBareName } from './bare-name.js';
import { rBoundName } from './assignment.js';
import { rOwningPackageDir } from './namespace-imports.js';
import {
  rExportPatternsIncomplete,
  rNamespaceExports,
  recordedRPackageConfig,
} from './package-config.js';
import {
  canonicalizeRenameBindings,
  createTreeSitterRenameSource,
  innermostRenameScope,
  walkNamedNodes,
} from '../rename-tree-sitter.js';

/**
 * Conservative semantic rename for R. Plain functions are renamed through the
 * scope-resolution graph. R binds names dynamically (S3/S4/R6 dispatch, strings,
 * NAMESPACE), so every declaration or name that the graph cannot prove is refused.
 */
const RESERVED = new Set(
  'if else repeat while function for next break TRUE FALSE NULL Inf NaN NA NA_integer_ NA_real_ NA_character_ NA_complex_ in'.split(
    ' ',
  ),
);

/** `r"(...)"`, `R'[...]'`, `r"---{...}---"`: no escapes; the body is taken as written. */
const RAW_STRING = /^[rR](["'])(-*)(?:\(([\s\S]*)\)|\[([\s\S]*)\]|\{([\s\S]*)\})\2\1$/;

/**
 * The value R holds for a string literal's source text, or null when it is not a
 * recognisable literal. Escapes are decoded (`"f\u006fo"` is `foo`), raw strings are
 * taken verbatim, so the guard compares what the string means, not how it is spelled.
 */
function rStringValue(text: string): string | null {
  const raw = RAW_STRING.exec(text);
  if (raw) return raw[3] ?? raw[4] ?? raw[5] ?? '';
  const quote = text[0];
  if ((quote !== '"' && quote !== "'") || text.length < 2 || text[text.length - 1] !== quote)
    return null;
  return unescapeRString(text.slice(1, -1));
}

/**
 * Generics of base R and its default packages that an S3 method name `generic.class` can register
 * against, whether or not the indexed sources define them: the S3 group generics (`Ops`, `Math`,
 * `Summary`, `Complex`, `matrixOps`) and the functions each group dispatches, the `is.*` and `as.*`
 * generics, and the common generics of base, stats, utils and graphics. Not exhaustive, and it
 * names no other package's generics (`tidy`, `filter`, ...); the repository's own functions are
 * checked separately.
 */
const BASE_GENERICS: ReadonlySet<string> = new Set(
  [
    // Group generics, and the members of the Math, Summary and Complex groups
    'Ops Math Summary Complex matrixOps',
    'abs sign sqrt floor ceiling trunc round signif exp log expm1 log1p cos sin tan cospi sinpi tanpi',
    'acos asin atan cosh sinh tanh acosh asinh atanh lgamma gamma digamma trigamma',
    'cumsum cumprod cummax cummin',
    'all any sum prod max min range',
    'Arg Conj Im Mod Re',
    // is.* and as.* generics
    'is.na is.nan is.finite is.infinite is.numeric is.array is.matrix is.unsorted is.list is.vector',
    'is.character is.logical is.integer is.double is.complex is.function is.environment',
    'as.character as.numeric as.integer as.logical as.double as.complex as.raw as.vector as.list',
    'as.data.frame as.matrix as.array as.Date as.POSIXct as.POSIXlt as.difftime as.factor as.table',
    'as.function as.environment as.name as.symbol as.call as.expression as.formula as.pairlist',
    'as.numeric_version as.package_version as.hexmode as.octmode as.roman as.person as.personList',
    'as.ts as.dist as.hclust as.dendrogram as.stepfun as.single',
    // base
    'print format summary length names dim dimnames levels rev sort rep seq unique duplicated',
    'anyDuplicated anyNA unlist c t cbind rbind toString all.equal labels diff scale cut split',
    'merge subset transform with within by aggregate droplevels relevel reorder xtfrm solve',
    'determinant rowsum row.names julian months weekdays quarters units open close flush seek',
    'truncate mean median quantile sort_by unsplit stack unstack kronecker aperm',
    // stats
    'update predict residuals coef fitted anova AIC BIC logLik nobs simulate terms formula family',
    'weights vcov deviance confint profile model.frame model.matrix sigma df.residual extractAIC',
    'add1 drop1 effects alias case.names variable.names dummy.coef proj influence rstandard',
    'rstudent cooks.distance hatvalues dfbeta dfbetas covratio density lag window time start end',
    'frequency cycle deltat na.omit na.exclude na.fail na.action naprint naresid napredict',
    'biplot screeplot qqnorm termplot knots cophenetic loadings smooth qr chol',
    // graphics and utils
    'plot lines points text image hist barplot boxplot pairs persp head tail str',
    'toBibtex toLatex',
  ]
    .join(' ')
    .split(' '),
);

/**
 * Whether `newName` reads as an S3 method `generic.class`: some dot-separated prefix of it is a
 * function the indexed sources define or a known base generic. Every dot is a possible split
 * (`to.json.foo` is a method of `to.json`; `as.data.frame.foo` of `as.data.frame`).
 */
export function registersS3Method(newName: string, defined: ReadonlySet<string>): boolean {
  for (let dot = newName.indexOf('.'); dot >= 0; dot = newName.indexOf('.', dot + 1)) {
    if (dot === 0) continue;
    const prefix = newName.slice(0, dot);
    if (defined.has(prefix) || BASE_GENERICS.has(prefix)) return true;
  }
  return false;
}

/**
 * Whether `node` is the name of a parameter. A default proves nothing about the argument a caller
 * passes, so every named formal is treated alike: a call of its name may reach the parameter (the
 * argument is a function) or a function of that name outside (it is not; R skips a non-function
 * binding when it looks up a callee), which cannot be decided statically. The provider therefore
 *
 *  - claims the formal as a binding, so a call of the name under it is not renamed with the
 *    function (`role` below), and refuses the rename when such a call exists (`checkSafety`);
 *  - reads a call of the NEW name under a formal of that name as a read of the new name, which the
 *    renamed function would capture (`readsNewName`);
 *  - leaves a plain read of the formal alone: it is a read of the argument, not of a function.
 */
export function isRParameterName(node: Parser.SyntaxNode): boolean {
  const parameter = node.parent;
  if (parameter?.type !== 'parameter' || parameter.childForFieldName('name')?.id !== node.id) {
    return false;
  }
  return parameter.parent?.parent?.type === 'function_definition';
}

/** Whether some function around `node` has a parameter called `name`. */
function hasEnclosingParameter(node: Parser.SyntaxNode, name: string): boolean {
  for (let ancestor = node.parent; ancestor !== null; ancestor = ancestor.parent) {
    if (ancestor.type !== 'function_definition') continue;
    const parameters = ancestor.childForFieldName('parameters');
    if (parameters === null) continue;
    for (const parameter of parameters.namedChildren) {
      if (parameter.type !== 'parameter') continue;
      const written = parameter.childForFieldName('name');
      if (written !== null && rBareName(written.text) === name) return true;
    }
  }
  return false;
}

/** Whether `node` is the callee of a call: `f(x)`, `x |> f()`. */
function isCallee(node: Parser.SyntaxNode): boolean {
  const call = node.parent;
  return call?.type === 'call' && call.childForFieldName('function')?.id === node.id;
}

/** The name a `<<-` or `->>` assignment writes to (backticks removed), or null for any other node. */
function superassignedName(node: Parser.SyntaxNode): string | null {
  if (node.type !== 'binary_operator') return null;
  const operator = node.childForFieldName('operator')?.text;
  if (operator !== '<<-' && operator !== '->>') return null;
  const target = node.childForFieldName(operator === '<<-' ? 'lhs' : 'rhs');
  return target?.type === 'identifier' ? rBareName(target.text) : null;
}

/** The left-hand side of `<-`, `=`, `<<-`, or the right-hand side of `->`, `->>`; null for any other node. */
function assignmentTarget(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
  if (node.type !== 'binary_operator') return null;
  const operator = node.childForFieldName('operator')?.text;
  if (operator === '<-' || operator === '=' || operator === '<<-')
    return node.childForFieldName('lhs');
  if (operator === '->' || operator === '->>') return node.childForFieldName('rhs');
  return null;
}

/**
 * Whether a call of `name` sits in the target of an assignment: `helper(z) <- 5`,
 * `helper(z)$a <- 1`, `names(helper(z)) <- v`. R runs the replacement function `helper<-`
 * there, not `helper`, so renaming the getter would strand the setter.
 */
function callsInAssignmentTarget(node: Parser.SyntaxNode, name: string): boolean {
  const target = assignmentTarget(node);
  // A plain name or a string names the variable being bound, not a function being called.
  if (target === null || target.type === 'identifier' || target.type === 'string') return false;
  for (const inner of walkNamedNodes(target)) {
    if (inner.type === 'identifier' && isCallee(inner) && rBareName(inner.text) === name)
      return true;
  }
  return false;
}

/** Whether `node` sits inside a function body or its parameter defaults. */
function insideFunction(node: Parser.SyntaxNode): boolean {
  for (let ancestor = node.parent; ancestor !== null; ancestor = ancestor.parent) {
    if (ancestor.type === 'function_definition') return true;
  }
  return false;
}

/**
 * Whether `node`, an identifier spelled like the new name, is used to READ a binding: a value
 * (`sapply(x, paste)`, `x <- letters`, a default `f = assist`) or a callee. After the rename
 * the renamed function is the global of that name, so a read that reached something else
 * (a base or attached object, another package's function) would be captured by it. Not reads:
 * a bound name (`assist <- 3`, a parameter, a `for` variable), an argument name (`f(assist = 1)`),
 * a member (`x$assist`, `x@assist`) and a qualified name (`pkg::assist`).
 */
function readsNewName(node: Parser.SyntaxNode, newName: string): boolean {
  const parent = node.parent;
  if (parent === null) return true;
  switch (parent.type) {
    case 'argument':
      if (parent.childForFieldName('name')?.id === node.id) return false;
      break;
    case 'parameter':
      if (parent.childForFieldName('name')?.id === node.id) return false;
      break;
    case 'extract_operator':
      if (parent.childForFieldName('rhs')?.id === node.id) return false;
      break;
    case 'namespace_operator':
      return false;
    case 'for_statement':
      if (parent.childForFieldName('variable')?.id === node.id) return false;
      break;
    case 'binary_operator':
      if (assignmentTarget(parent)?.id === node.id) return false;
      break;
  }
  // A parameter of an enclosing function binds the name locally, so a plain read of it never
  // reaches the global. A CALL of it may: a default proves nothing about the argument, and R
  // skips a non-function binding, so the call can reach the global the renamed function becomes.
  return !hasEnclosingParameter(node, newName) || isCallee(node);
}

/**
 * A name R also writes between its operands: an infix function (`%+%`, `%in%`) or an operator
 * (`+`, `[[`). Its uses are operator tokens, not `identifier` nodes, so a rename would edit the
 * definition and leave every `a %+% b` calling a function that no longer exists.
 */
function isOperatorName(name: string): boolean {
  return /^%.*%$/.test(name) || /^[^A-Za-z0-9._]+$/.test(name);
}

const collision = (message: string): RenameIssue => ({ code: 'name_collision', message });

const unsupported = (message: string): RenameIssue => ({
  code: 'unsupported_occurrence',
  status: 'unsupported',
  message,
});

// A backticked symbol is an `identifier` whose text keeps its backticks. Both spellings name the
// same symbol, so occurrences, claims and bindings are matched on the symbol.
const parseNames = createTreeSitterRenameSource({
  isName: (node) => node.type === 'identifier',
  canonicalName: rBareName,
  transformParsed: (parsed) => canonicalizeRenameBindings(parsed, rBareName),
  skip: (node) => node.type === 'comment',
  role: (node) => {
    // Every parameter is claimed as a binding, whatever its default (see `isRParameterName`).
    return isRParameterName(node) ? 'binding' : 'name';
  },
});

/**
 * Functions R itself calls by name: package load and unload hooks and the session start and end
 * hooks. A rename would leave them defined under a name nothing calls.
 */
const R_HOOK_FUNCTIONS: ReadonlySet<string> = new Set([
  '.onLoad',
  '.onAttach',
  '.onUnload',
  '.onDetach',
  '.First',
  '.Last',
  '.First.sys',
  '.First.lib',
  '.Last.lib',
]);

/**
 * The name the engine compares a graph symbol with the scope definition of. The engine reads a
 * definition's simple name as the text after the last `.` of its qualified name (the rule that
 * splits an owner from a member), which turns the leading-dot name `.helper` into `helper`; for a
 * name that is only a leading dot and one word, the simple name is the whole name. Dotted names
 * with a dot inside (`print.foo`, `.helper.foo`) are S3-style owner-qualified names and keep the
 * engine's reading, so they stay refused.
 */
function rCanonicalName(
  name: string,
  context?: Parameters<NonNullable<RenameProvider['canonicalName']>>[1],
): string {
  const bare = rBareName(name);
  const qualified = context?.definition?.qualifiedName;
  if (qualified === undefined) return bare;
  const full = rBareName(qualified);
  return /^\.[^.]+$/.test(full) && bare === full.slice(1) ? full : bare;
}

export const rRenameProvider: RenameProvider = {
  canonicalName: rCanonicalName,
  validateName(name) {
    // `...`, `..1`, `..2`, ... refer to the arguments passed down to a function; R reserves them.
    if (name === '...' || /^\.\.[0-9]+$/.test(name))
      return {
        code: 'invalid_name',
        message:
          'Choose a valid nonreserved R identifier: `...` and `..1`, `..2`, ... are reserved.',
      };
    if (/[^\x00-\x7f]/.test(name))
      return {
        code: 'invalid_name',
        message:
          'Choose a valid nonreserved R identifier. New names are limited to ASCII letters, digits, `.` and `_` (conservative by design).',
      };
    if (!/^(?:[A-Za-z]|\.(?![0-9]))[A-Za-z0-9._]*$/.test(name) || RESERVED.has(name))
      return { code: 'invalid_name', message: 'Choose a valid nonreserved R identifier.' };
  },
  async parseSource(input) {
    const source = await parseNames(input);
    // Parameters shadow same-named functions: claim them per scope so the engine
    // leaves an unrelated parameter alone.
    const claims = new Map<string, NameClaim[]>();
    for (const occurrence of source.occurrences) {
      if (occurrence.role !== 'binding' || !occurrence.node) continue;
      const scope = innermostRenameScope(source.parsed, occurrence.node);
      if (!scope) continue;
      claims.set(scope, [
        ...(claims.get(scope) ?? []),
        {
          name: occurrence.name,
          range: occurrence.range,
          kind: 'binding',
          hoisted: true,
          purpose: 'value',
        },
      ]);
    }
    return {
      ...source,
      parsed: {
        ...source.parsed,
        scopes: source.parsed.scopes.map((scope) => ({
          ...scope,
          nameClaims: [...(scope.nameClaims ?? []), ...(claims.get(scope.id) ?? [])],
        })),
      },
    };
  },
  checkSafety({ target, newName, files, graph }) {
    const name = rBareName(target.qualifiedName ?? '');
    if (target.type !== 'Function')
      return unsupported('Only plain R functions can be renamed; classes and members are refused.');
    if (R_HOOK_FUNCTIONS.has(name))
      return unsupported(
        'R calls this function by name (a package or session hook); a renamed one would no longer run.',
      );
    // `f(x) <- v` calls the replacement function `f<-`, so a name ending in `<-` is half of a pair
    // whose other half is written differently.
    if (name.endsWith('<-') || newName.endsWith('<-'))
      return unsupported(
        'A replacement function (`name<-`) is called as `name(x) <- value`; those calls are not renamed.',
      );
    // A name made only of non-ASCII characters (`λ`) is an identifier in a UTF-8 session, not an
    // operator; the provider reads ASCII names only, so it says that rather than "operator".
    if (/^[^\x00-\x7f]+$/.test(name))
      return unsupported(
        'Only ASCII identifiers are renamed; this name is not a supported identifier.',
      );
    if (isOperatorName(name) || isOperatorName(newName))
      return unsupported(
        'An infix function or operator (`%op%`, `+`) is also written between its operands; those uses are not renamed.',
      );
    // Only a function can be an S3 generic: an R6 or S4 class, a member or a field of the same
    // spelling is not one, so a name like `Widget.foo` beside `Widget <- R6Class(...)` is free.
    const defined = new Set(
      [...files.values()].flatMap((source) =>
        source.parsed.localDefs.flatMap((d) =>
          d.type !== 'Function' || d.qualifiedName === undefined
            ? []
            : [rBareName(d.qualifiedName)],
        ),
      ),
    );
    if (registersS3Method(newName, defined))
      return unsupported(
        'The new name would register an S3 method of an existing function or base generic.',
      );
    // R keeps one global per name. A function of the new name in another file is a second
    // definition (load order decides which survives); one in this file is the engine's check.
    for (const [path, source] of files) {
      if (path === target.filePath) continue;
      if (
        source.parsed.localDefs.some(
          (d) =>
            d.type === 'Function' &&
            d.qualifiedName !== undefined &&
            rBareName(d.qualifiedName) === newName,
        )
      )
        return collision('Another file already defines a function of the new name.');
    }
    for (const source of files.values()) {
      if (!source.tree) continue;
      for (const node of walkNamedNodes(source.tree.rootNode)) {
        // A top-level variable of the new name (or a `<<-` to it) would be replaced by the
        // renamed function, or would replace it, depending on which assignment runs last.
        if (
          (rBoundName(node) === newName && !insideFunction(node)) ||
          superassignedName(node) === newName
        )
          return collision('The new name is already assigned as a variable at top level.');
        if (
          node.type === 'identifier' &&
          rBareName(node.text) === newName &&
          readsNewName(node, newName)
        )
          return collision(
            'The new name is already read here as a value or called; the renamed function would capture it.',
          );
        // `name <<- value` (inside a function or not) is a global re-definition that the
        // scope graph keeps as a separate declaration, so a rename would leave it behind.
        if (node.type === 'identifier' && isCallee(node) && rBareName(node.text) === name) {
          if (hasEnclosingParameter(node, name))
            return {
              code: 'ambiguous_reference',
              message:
                'A parameter of this name may hold a function, so this call may reach the parameter or the function being renamed.',
            };
        }
        if (callsInAssignmentTarget(node, name))
          return unsupported(
            'A call of this name is the target of an assignment (`name(x) <- value`), which calls the replacement function `name<-`; a rename would strand it.',
          );
        if (superassignedName(node) === name)
          return {
            code: 'ambiguous_reference',
            message:
              'This name is also assigned with <<- or ->>; the global re-assignment is not renamed with it.',
          };
        if (node.type !== 'string') continue;
        const value = rStringValue(node.text);
        // `"name<-" <- function(x, value)` defines the replacement function by string.
        if (
          value !== null &&
          (value === name || value === newName || value === `${name}<-` || value === `${newName}<-`)
        )
          return unsupported(
            'A string literal spells this name; S3, S4, R6 and dynamic lookup resolve it by string.',
          );
      }
    }
    // NAMESPACE is not an indexed source, so an `export()`, `exportPattern()` or `S3method()`
    // entry naming this function would be left behind by a rename. The persisted `isExported`
    // is not proof of privacy: an edit of NAMESPACE alone does not re-process the unchanged
    // `R/` files, so the flag can be stale. It is only half of the proof; the other half is the
    // NAMESPACE the planner has just loaded from disk for this plan.
    const file = target.filePath;
    if (!/(^|\/)R\//.test(file)) return;
    // roxygen2 regenerates NAMESPACE from `@export*` tags on the next `document()`, so a tag on
    // the function's block would export the new name (and drop the old one) even when the
    // NAMESPACE on disk says private now.
    const tree = files.get(file)?.tree;
    if (tree && hasRoxygenExportTag(tree.rootNode, name))
      return unsupported(
        'A roxygen2 @export tag is attached to this function; renaming it would change the exported name when NAMESPACE is next regenerated.',
      );
    let exported = false;
    graph.forEachNode((node) => {
      if (
        node.label === 'Function' &&
        node.properties.filePath === file &&
        typeof node.properties.name === 'string' &&
        rBareName(node.properties.name) === name &&
        node.properties.isExported !== false
      )
        exported = true;
    });
    if (exported)
      return unsupported(
        'A package function that NAMESPACE exports, or that the index cannot prove private, may have an export entry that is not renamed.',
      );
    return currentNamespaceIssue(files.get(file)?.parsed, file, name);
  },
};

/** A roxygen2 tag that adds its object to NAMESPACE: `@export`, `@exportMethod`, `@exportS3Method`, ... */
const ROXYGEN_EXPORT_TAG = /^#'[ \t]*@export\w*(?:[ \t]|$)/;

/**
 * Whether a top-level assignment of `name` in the file carries a roxygen2 `@export*` tag: a
 * `#'` line in the run of comments that directly precedes it (a plain `#` comment in between
 * does not break the run, as when roxygen2 collects the block). Text only; the tags are not parsed.
 */
function hasRoxygenExportTag(root: Parser.SyntaxNode, name: string): boolean {
  for (const node of walkNamedNodes(root)) {
    if (rBoundName(node) !== name || insideFunction(node)) continue;
    for (let sibling = node.previousSibling; sibling; sibling = sibling.previousSibling) {
      if (sibling.type !== 'comment') {
        if (sibling.isNamed) break;
        continue;
      }
      if (ROXYGEN_EXPORT_TAG.test(sibling.text)) return true;
    }
  }
  return false;
}

/**
 * Whether the NAMESPACE read from disk for this plan leaves `name` (defined in `file`) private.
 * Fail-closed: anything short of a NAMESPACE that was read, parsed completely and does not export
 * the name is a refusal, so a stale persisted verdict cannot make a rename that strands an export
 * go through.
 */
function currentNamespaceIssue(
  parsed: object | undefined,
  file: string,
  name: string,
): RenameIssue | void {
  const config = recordedRPackageConfig(parsed);
  if (config === undefined)
    return {
      code: 'incomplete_semantics',
      status: 'unsupported',
      message:
        'The package NAMESPACE was not read for this rename, so the function cannot be proven private.',
    };
  const packageDir = rOwningPackageDir(file, config);
  const info =
    packageDir === undefined ? undefined : config.namespaceInfoByPackageDir.get(packageDir);
  if (info === undefined || !info.hasNamespaceFile)
    return {
      code: 'incomplete_semantics',
      status: 'unsupported',
      message:
        'The package has no NAMESPACE file that could be read now (it may have been removed or be unreadable), so the function cannot be proven private.',
    };
  if (rNamespaceExports(info, name))
    return unsupported(
      'The package NAMESPACE now exports this function (export(), exportPattern() or S3method()); that entry would not be renamed. Re-run analyze to refresh the index.',
    );
  if (rExportPatternsIncomplete(info))
    return {
      code: 'incomplete_semantics',
      status: 'unsupported',
      message:
        'An exportPattern() of the package NAMESPACE could not be fully applied, so the function cannot be proven private.',
    };
  if (info.exportsUnreadable === true)
    return {
      code: 'incomplete_semantics',
      status: 'unsupported',
      message:
        'The package NAMESPACE has an export directive the reader cannot apply (a conditional export, a raw-string or multi-line argument, or a malformed directive), so the function cannot be proven private.',
    };
}
