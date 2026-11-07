import type Parser from 'tree-sitter';
import type { NameClaim, ParsedFile, Range } from 'gitnexus-shared';
import type {
  RenameIssue,
  RenameProvider,
  RenameSemanticContext,
  RenameSource,
} from '../../rename-provider.js';
import { unescapeRString } from './export-pattern.js';
import { rBareName } from './bare-name.js';
import { assignmentTarget, isCallee, rBoundName, rLexicalAssignedNames } from './assignment.js';
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
  innermostRenameScopeAt,
  nodeRange,
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
    // pretty() (base; grDevices registers pretty.Date) and stats' weighted.mean()
    'pretty weighted.mean',
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

/** The name a `<<-` or `->>` assignment writes to (backticks removed), or null for any other node. */
function superassignedName(node: Parser.SyntaxNode): string | null {
  if (node.type !== 'binary_operator') return null;
  const operator = node.childForFieldName('operator')?.text;
  if (operator !== '<<-' && operator !== '->>') return null;
  const target = node.childForFieldName(operator === '<<-' ? 'lhs' : 'rhs');
  return target?.type === 'identifier' ? rBareName(target.text) : null;
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

/** A regular expression that matches `name` literally. */
const escapeRegExp = (name: string): string => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Characters that continue an R identifier, so a match next to one is part of a longer name. */
const NAME_CHAR = 'A-Za-z0-9._';

/** The source text of a rename source (hand-built test sources may carry only the tree). */
const sourceText = (source: RenameSource): string =>
  source.content ?? source.tree?.rootNode.text ?? '';

/**
 * Generated R sources (Rcpp's `RcppExports.R`, cpp11's `cpp11.R`, roxygen2 output, usethis
 * standalone files) say so in their first lines. The generator rewrites them from other inputs,
 * so a rename edit there is reverted on the next regeneration.
 */
const GENERATED_HEADER = /Generated by|do not edit by hand/i;

export function isGeneratedRSource(text: string): boolean {
  return GENERATED_HEADER.test(text.split('\n', 5).join('\n'));
}

/** Whether an identifier spelled `name` occurs anywhere in the tree. */
function mentionsName(root: Parser.SyntaxNode, name: string): boolean {
  for (const node of walkNamedNodes(root)) {
    if (node.type === 'identifier' && rBareName(node.text) === name) return true;
  }
  return false;
}

/** Whether `inner` lies within `outer` (byte offsets). */
const within = (inner: Parser.SyntaxNode, outer: Parser.SyntaxNode): boolean =>
  inner.startIndex >= outer.startIndex && inner.endIndex <= outer.endIndex;

const sameRange = (a: Range, b: Range): boolean =>
  a.startLine === b.startLine &&
  a.startCol === b.startCol &&
  a.endLine === b.endLine &&
  a.endCol === b.endCol;

/**
 * Whether the binding `node` (an assignment or `for` loop) is made at the top level of its file:
 * in the Module scope, not in a function or in a block scope (`local({})`, `test_that()`, ...).
 * The scope of the assignment's own function or R6 class, which spans the assignment node itself,
 * is skipped. A source without scopes (a hand-built test source) reads only the function nesting.
 */
function bindsAtTopLevel(parsed: ParsedFile | undefined, node: Parser.SyntaxNode): boolean {
  if (insideFunction(node)) return false;
  if (parsed?.scopes === undefined) return true;
  const range = nodeRange(node);
  let scopeId = innermostRenameScopeAt(parsed, range);
  const own = parsed.scopes.find((scope) => scope.id === scopeId);
  if (own !== undefined && sameRange(own.range, range)) scopeId = own.parent ?? undefined;
  return scopeId === parsed.moduleScope;
}

/** Whether the file binds `name` at top level (a function or any other value). */
function definesAtTopLevel(source: RenameSource, name: string): boolean {
  if (!source.tree) return false;
  for (const node of walkNamedNodes(source.tree.rootNode)) {
    if (rBoundName(node) === name && bindsAtTopLevel(source.parsed, node)) return true;
  }
  return false;
}

/** The value side of a local `<-`, `=` or `->` assignment of `name`, or null. */
function locallyAssignedValue(node: Parser.SyntaxNode, name: string): Parser.SyntaxNode | null {
  if (node.type !== 'binary_operator' || rBoundName(node) !== name) return null;
  const operator = node.childForFieldName('operator')?.text;
  if (operator === '<-' || operator === '=') return node.childForFieldName('rhs');
  if (operator === '->') return node.childForFieldName('lhs');
  return null;
}

/** The calls of `name` (an identifier callee) under `root`. */
function callsOf(root: Parser.SyntaxNode, name: string): Parser.SyntaxNode[] {
  const calls: Parser.SyntaxNode[] = [];
  for (const node of walkNamedNodes(root)) {
    if (node.type === 'identifier' && isCallee(node) && rBareName(node.text) === name)
      calls.push(node);
  }
  return calls;
}

/** Calls whose braces get a block scope of their own (the `@scope.block` patterns of query.ts). */
const BLOCK_SCOPE_CALLS = /^(local|test_that|describe|it|with|within)$/;

/** Whether `node` is the braces of a block scope: `local({...})`, `test_that(desc, {...})`, ... */
function isBlockScopeBody(node: Parser.SyntaxNode): boolean {
  if (node.type !== 'braced_expression' || node.parent?.type !== 'argument') return false;
  if (node.parent.childForFieldName('value')?.id !== node.id) return false;
  const call = node.parent.parent?.parent;
  if (call?.type !== 'call') return false;
  let callee = call.childForFieldName('function');
  if (callee?.type === 'namespace_operator') callee = callee.childForFieldName('rhs');
  return callee?.type === 'identifier' && BLOCK_SCOPE_CALLS.test(callee.text);
}

/**
 * Whether a function body or a block scope's braces may call `name` before its own local
 * definition of it. The scope graph binds every call of the name in a body (nested functions and
 * blocks included) to a function literal the body assigns to it, wherever the assignment sits;
 * R binds the local only once the assignment has run. So the binding is accepted only when one
 * such assignment is a direct statement of the body's braces (not under `if`, `switch()`, a
 * loop, `tryCatch()` or any call) and every call of the name in the body starts after it ends (a
 * call inside that literal runs after it too).
 */
export function rCallsBeforeLocalDefinition(root: Parser.SyntaxNode, name: string): boolean {
  for (const fn of walkNamedNodes(root)) {
    const body =
      fn.type === 'function_definition'
        ? fn.childForFieldName('body')
        : isBlockScopeBody(fn)
          ? fn
          : null;
    if (body === null) continue;
    // Assignments made by this body itself: nested functions and blocks own theirs.
    const definitions: Parser.SyntaxNode[] = [];
    const stack: Parser.SyntaxNode[] = [body];
    for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
      if (node.type === 'function_definition' || (node.id !== body.id && isBlockScopeBody(node)))
        continue;
      if (locallyAssignedValue(node, name)?.type === 'function_definition') definitions.push(node);
      for (const child of node.namedChildren) stack.push(child);
    }
    if (definitions.length === 0) continue;
    const calls = callsOf(body, name);
    if (calls.length === 0) continue;
    const first = definitions
      .filter((d) => body.type === 'braced_expression' && d.parent?.id === body.id)
      .sort((a, b) => a.startIndex - b.startIndex)[0];
    if (first === undefined) return true;
    if (calls.some((call) => !within(call, first) && call.startIndex < first.endIndex)) return true;
  }
  return false;
}

/**
 * Whether a top-level call of `name` in the file runs before the definition at `at`: top-level
 * expressions run in order, so it reaches whatever `name` was before (a base or attached
 * function), while the module scope binds it to the later definition.
 */
function topLevelCallBeforeDefinition(root: Parser.SyntaxNode, name: string, at: Range): boolean {
  const definition = root.descendantForPosition({ row: at.startLine - 1, column: at.startCol });
  if (insideFunction(definition)) return false;
  for (const call of callsOf(root, name)) {
    if (insideFunction(call)) continue;
    const row = call.startPosition.row + 1;
    if (row < at.startLine || (row === at.startLine && call.startPosition.column < at.startCol))
      return true;
  }
  return false;
}

/** Whether `call` calls `fn`, bare or `pkg::`/`pkg:::`-qualified. */
function callsFunction(call: Parser.SyntaxNode, fn: string): boolean {
  if (call.type !== 'call') return false;
  const callee = call.childForFieldName('function');
  if (callee?.type === 'identifier') return callee.text === fn;
  if (callee?.type === 'namespace_operator') return callee.childForFieldName('rhs')?.text === fn;
  return false;
}

/** The arguments of a call, with the name each is passed by (`undefined` when unnamed). */
function callArguments(call: Parser.SyntaxNode): { name?: string; value: Parser.SyntaxNode }[] {
  const result: { name?: string; value: Parser.SyntaxNode }[] = [];
  for (const argument of call.childForFieldName('arguments')?.namedChildren ?? []) {
    if (argument.type !== 'argument') continue;
    const value = argument.childForFieldName('value');
    if (value === null) continue;
    const written = argument.childForFieldName('name');
    result.push({ name: written ? rBareName(written.text) : undefined, value });
  }
  return result;
}

/**
 * Whether a bare call of `name` in a portable R6 method is recorded as blocked by a class member
 * of that name. R6 puts the members on the class scope that encloses every method, so the
 * lookup from a method stops at the member, which the resolver hides, and records the site as
 * `blocked` with the member as its target; the rename engine then reads it as a use of another
 * declaration and leaves it. In a portable class (the default) a method sees members only as
 * `self$`/`private$`, so the call really reaches the function being renamed. A non-portable
 * class (`portable = FALSE`) and a RefClass method do see the member by bare name.
 */
function portableR6MemberBlocksCall(context: RenameSemanticContext, name: string): boolean {
  if (context.referenceBindings === undefined) return false;
  const types = new Map((context.definitions ?? []).map((d) => [d.nodeId, d.type]));
  const sourceOfScope = new Map<string, RenameSource>();
  for (const source of context.files.values())
    for (const scope of source.parsed.scopes ?? []) sourceOfScope.set(scope.id, source);
  for (const [site, binding] of context.referenceBindings) {
    if (site.kind !== 'call' || site.explicitReceiver !== undefined) continue;
    if (rBareName(site.name) !== name) continue;
    if (binding.status !== 'blocked' || binding.basis !== 'callable-visibility') continue;
    if (
      binding.targetDefIds.length === 0 ||
      !binding.targetDefIds.every((id) => types.get(id) === 'Method')
    )
      continue;
    const root = sourceOfScope.get(site.inScope)?.tree?.rootNode;
    if (root === undefined) continue;
    const at = site.nameRange ?? site.atRange;
    let node: Parser.SyntaxNode | null = root.descendantForPosition({
      row: at.startLine - 1,
      column: at.startCol,
    });
    for (; node !== null; node = node.parent) {
      if (!callsFunction(node, 'R6Class')) continue;
      const nonPortable = callArguments(node).some(
        (a) => a.name === 'portable' && (a.value.text === 'FALSE' || a.value.text === 'F'),
      );
      if (!nonPortable) return true;
      break;
    }
  }
  return false;
}

interface RClassShape {
  readonly contains: string[];
  readonly members: Set<string>;
}

const strings = (node: Parser.SyntaxNode): string[] => {
  if (node.type === 'string') {
    const value = rStringValue(node.text);
    return value === null ? [] : [value];
  }
  if (callsFunction(node, 'c')) return callArguments(node).flatMap((a) => strings(a.value));
  return [];
};

/** Member names given by `list(a = ...)`, `c(a = "x")`, `representation(...)` or `c("a", "b")`. */
const memberNames = (node: Parser.SyntaxNode): string[] =>
  node.type !== 'call'
    ? []
    : callArguments(node).flatMap((a) =>
        a.name !== undefined ? [a.name] : a.value.type === 'string' ? strings(a.value) : [],
      );

/**
 * The classes `setRefClass()` and `setClass()` define in the indexed sources: each name (the
 * `Class =` argument, else the first unnamed string) with its `contains =` parents and the
 * methods, fields and slots it lists. Classes defined twice are merged.
 */
function rClassShapes(files: ReadonlyMap<string, RenameSource>): Map<string, RClassShape> {
  const shapes = new Map<string, RClassShape>();
  for (const source of files.values()) {
    if (!source.tree) continue;
    for (const call of walkNamedNodes(source.tree.rootNode)) {
      if (!callsFunction(call, 'setRefClass') && !callsFunction(call, 'setClass')) continue;
      const args = callArguments(call);
      const named = args.find((a) => a.name === 'Class') ?? args.find((a) => a.name === undefined);
      const className = named?.value.type === 'string' ? rStringValue(named.value.text) : null;
      if (className === null) continue;
      const shape = shapes.get(className) ?? { contains: [], members: new Set<string>() };
      for (const a of args) {
        if (a.name === 'contains') shape.contains.push(...strings(a.value));
        if (['methods', 'fields', 'slots', 'representation'].includes(a.name ?? ''))
          for (const member of memberNames(a.value)) shape.members.add(member);
      }
      shapes.set(className, shape);
    }
  }
  return shapes;
}

/** Base classes R provides itself, which add no method a reference method can call by name. */
const BUILTIN_REFCLASS_BASES: ReadonlySet<string> = new Set(['envRefClass', 'VIRTUAL']);

/**
 * Whether a bare call of `name` in a RefClass method may reach an inherited method or field: R
 * installs the inherited methods a reference method uses, so the call reaches a parent's member
 * of that name, while the scope graph does not follow `contains =` and binds the call to the
 * function being renamed. Refused also when a parent is not defined in the indexed sources.
 */
function refClassInheritsName(files: ReadonlyMap<string, RenameSource>, name: string): boolean {
  let shapes: Map<string, RClassShape> | undefined;
  for (const source of files.values()) {
    if (!source.tree) continue;
    for (const call of callsOf(source.tree.rootNode, name)) {
      let argument: Parser.SyntaxNode | null = null;
      let className: string | null = null;
      for (let node: Parser.SyntaxNode | null = call.parent; node !== null; node = node.parent) {
        if (node.type === 'argument') argument = node;
        if (!callsFunction(node, 'setRefClass')) continue;
        const written = argument?.childForFieldName('name');
        if (
          argument?.parent?.parent?.id === node.id &&
          written &&
          rBareName(written.text) === 'methods'
        ) {
          const args = callArguments(node);
          const named =
            args.find((a) => a.name === 'Class') ?? args.find((a) => a.name === undefined);
          className = named?.value.type === 'string' ? rStringValue(named.value.text) : null;
        }
        break;
      }
      if (className === null) continue;
      shapes ??= rClassShapes(files);
      const queue = [...(shapes.get(className)?.contains ?? [])];
      const seen = new Set<string>([className]);
      for (let parent = queue.shift(); parent !== undefined; parent = queue.shift()) {
        if (seen.has(parent) || BUILTIN_REFCLASS_BASES.has(parent)) continue;
        seen.add(parent);
        const shape = shapes.get(parent);
        if (shape === undefined || shape.members.has(name)) return true;
        queue.push(...shape.contains);
      }
    }
  }
  return false;
}

/**
 * Whether a `$methods(...)` call (`Gen$methods(run = function() helper())`, which adds methods to
 * a RefClass generator after `setRefClass()`) mentions `name`. A method added that way sees the
 * class's methods by bare name, and a method of that name added there is seen by every method of
 * the class; the class scope does not model these calls, so the scope graph binds such a call to
 * the function being renamed. The receiver is not traced: any `x$methods(...)` counts.
 */
function refClassMethodsCallMentionsName(
  files: ReadonlyMap<string, RenameSource>,
  name: string,
): boolean {
  for (const source of files.values()) {
    if (!source.tree) continue;
    for (const call of walkNamedNodes(source.tree.rootNode)) {
      if (call.type !== 'call') continue;
      const callee = call.childForFieldName('function');
      if (callee?.type !== 'extract_operator' || callee.childForFieldName('operator')?.text !== '$')
        continue;
      if (rBareName(callee.childForFieldName('rhs')?.text ?? '') !== 'methods') continue;
      const args = call.childForFieldName('arguments');
      if (args !== null && mentionsName(args, name)) return true;
    }
  }
  return false;
}

/**
 * Whether a roxygen2 line of the package's `R/` files would write `name` into NAMESPACE on the
 * next `document()` although it is not attached to the definition: `@rawNamespace` text that
 * names it (copied verbatim), or `@export name` (an export tag that names its object, as on a
 * `NULL` block).
 */
function roxygenNamesInNamespace(
  files: ReadonlyMap<string, RenameSource>,
  file: string,
  name: string,
): boolean {
  const config = recordedRPackageConfig(files.get(file)?.parsed);
  if (config === undefined) return false;
  const packageDir = rOwningPackageDir(file, config);
  const word = new RegExp(`(?<![${NAME_CHAR}])${escapeRegExp(name)}(?![${NAME_CHAR}])`);
  const exportTag = new RegExp(`@export\\w*[ \\t]+${escapeRegExp(name)}(?![${NAME_CHAR}])`);
  for (const [path, source] of files) {
    if (rOwningPackageDir(path, config) !== packageDir) continue;
    for (const line of sourceText(source).split('\n')) {
      const text = line.trimStart();
      if (!text.startsWith("#'")) continue;
      if ((/@rawNamespace\b/.test(text) && word.test(text)) || exportTag.test(text)) return true;
    }
  }
  return false;
}

const collision = (message: string): RenameIssue => ({ code: 'name_collision', message });

const unsupported = (message: string): RenameIssue => ({
  code: 'unsupported_occurrence',
  status: 'unsupported',
  message,
});

const ambiguous = (message: string): RenameIssue => ({ code: 'ambiguous_reference', message });

const GENERATED_MESSAGE =
  'A generated R file (its header says "Generated by" or "do not edit by hand") uses this name; its generator would restore the old name.';

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
  checkSafety(context) {
    const { target, newName, files, graph } = context;
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
    // Rcpp/cpp11 wrappers and other generated files are rewritten from their inputs, which
    // still say the old name: the definition, or any use, in such a file would be reverted.
    for (const [path, source] of files) {
      if (!isGeneratedRSource(sourceText(source))) continue;
      if (path === target.filePath || (source.tree && mentionsName(source.tree.rootNode, name)))
        return unsupported(GENERATED_MESSAGE);
    }
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
    // The same holds for the old name: a second top-level definition in a file loaded with the
    // target's (the same package's R/ files, or files outside every package) means load order
    // decides which one callers reach. A definition inside a function or a block scope
    // (`test_that()`, `local()`, ...) binds only there.
    const recorded = recordedRPackageConfig(files.get(target.filePath)?.parsed);
    const loadUnit = rOwningPackageDir(target.filePath, recorded);
    for (const [path, source] of files) {
      if (path === target.filePath || rOwningPackageDir(path, recorded) !== loadUnit) continue;
      if (definesAtTopLevel(source, name))
        return ambiguous(
          'This name is defined in more than one file; load order decides which definition callers reach.',
        );
    }
    const callInString = new RegExp(`(?<![${NAME_CHAR}])${escapeRegExp(name)}\\s*\\(`);
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
        // A body assignment of this name to a value that may be a function (`helper <- identity`)
        // makes the name local to that function, flow-insensitively: a call before it, under an
        // `if`, or no call at all cannot be told apart from a use of the function being renamed.
        // The scope captures read the same assignments (`rLexicalAssignedNames`).
        if (node.type === 'function_definition') {
          for (const assigned of rLexicalAssignedNames(node)) {
            if (rBareName(assigned) === name)
              return {
                code: 'ambiguous_reference',
                message: 'A local assignment of this name may shadow the function being renamed.',
              };
          }
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
        // glue/cli `{name(x)}`, `parse(text = "name(1)")`, `str2lang()` and formula strings are
        // evaluated as R code. A plain mention of the word is prose and is not refused.
        if (value !== null && callInString.test(value))
          return unsupported(
            'A string literal contains a call of this name (glue/cli interpolation, parse(text=), a formula string); it would not be renamed.',
          );
      }
    }
    const targetSource = files.get(target.filePath);
    const definedAt = target.nameRange ?? target.declarationRange;
    if (
      targetSource?.tree &&
      definedAt !== undefined &&
      topLevelCallBeforeDefinition(targetSource.tree.rootNode, name, definedAt)
    )
      return ambiguous(
        'A top-level call of this name runs before the definition; it reaches another function of that name.',
      );
    for (const source of files.values()) {
      if (source.tree && rCallsBeforeLocalDefinition(source.tree.rootNode, name))
        return ambiguous('A call may run before the local definition of this name.');
    }
    if (portableR6MemberBlocksCall(context, name))
      return ambiguous(
        'A bare call inside a portable R6 method does not see class members; it reaches the function being renamed but has no proven edge.',
      );
    if (refClassInheritsName(files, name))
      return ambiguous(
        'A RefClass method calls this name and a parent class (contains =) defines a member of it, or is not indexed; the call may reach the inherited member.',
      );
    if (refClassMethodsCallMentionsName(files, name))
      return ambiguous(
        'A $methods() call (methods added to a RefClass generator) mentions this name; the index does not model those methods, so a call may reach a class method instead of the function being renamed.',
      );
    // R files the index does not cover (skipped directories, `.Rprofile`, `R/*.S`), recorded
    // by `refreshResolutionConfig` for this plan.
    for (const unindexed of recorded?.unindexedRSources ?? []) {
      if (unindexed.unreadable === true)
        return {
          code: 'incomplete_semantics',
          status: 'unsupported',
          message: `An R file the index does not cover (${unindexed.path}) could not be read in full, so it may call this name; it would not be updated.`,
        };
      if (unindexed.words.includes(name))
        return {
          code: 'incomplete_semantics',
          status: 'unsupported',
          message: `An R file the index does not cover (${unindexed.path}) mentions this name; it would not be updated.`,
        };
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
    if (roxygenNamesInNamespace(files, file, name))
      return unsupported(
        'A roxygen2 @rawNamespace or @export line of the package names this function; the next document() would write the old name into NAMESPACE.',
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
    return currentNamespaceIssue(files.get(file)?.parsed, file, name, newName);
  },
  // A second line of defence for generated files (see `checkSafety`): never edit one.
  validateRewrite({ source, edits }) {
    if (edits.length > 0 && isGeneratedRSource(sourceText(source)))
      return unsupported(GENERATED_MESSAGE);
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
  newName: string,
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
  // A registered S3 method is not exported for resolution, but it is public API: refused alike.
  if (rNamespaceExports(info, name) || info.s3Registered?.has(name) === true)
    return unsupported(
      'The package NAMESPACE now exports this function (export(), exportPattern() or S3method()); that entry would not be renamed. Re-run analyze to refresh the index.',
    );
  // A private function renamed into an exported name changes the package API.
  if (rNamespaceExports(info, newName))
    return unsupported(
      'The new name would be exported by NAMESPACE (export()/exportPattern()), changing the package API.',
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
