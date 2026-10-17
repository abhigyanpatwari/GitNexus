import type Parser from 'tree-sitter';
import type { NameClaim } from 'gitnexus-shared';
import type { RenameIssue, RenameProvider } from '../../rename-provider.js';
import { unescapeRString } from './export-pattern.js';
import { rBareName } from './bare-name.js';
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
 * against, whether or not the indexed sources define them. Not exhaustive: it covers the generics
 * a project is most likely to meet by accident, and the repository's own functions are checked
 * separately.
 */
const BASE_GENERICS: ReadonlySet<string> = new Set(
  (
    'print format summary plot lines points text image hist barplot boxplot pairs persp ' +
    'as.character as.data.frame as.list as.vector as.numeric as.integer as.logical as.matrix ' +
    'as.Date as.POSIXct as.POSIXlt as.factor as.table as.function as.environment as.double ' +
    'length names dim dimnames levels rev sort unique duplicated anyDuplicated rep seq ' +
    'mean median quantile range max min round diff scale cut split merge subset transform ' +
    'with within head tail t c cbind rbind toString all.equal is.na labels str ' +
    'update predict residuals coef fitted anova simulate terms formula family weights ' +
    'vcov logLik AIC BIC nobs deviance confint profile model.frame row.names open close ' +
    'by aggregate droplevels relevel reorder xtfrm solve determinant julian months weekdays'
  ).split(' '),
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

/** Default values that can never be a function. */
const CONSTANT_DEFAULTS: ReadonlySet<string> = new Set([
  'float',
  'integer',
  'complex',
  'string',
  'true',
  'false',
  'null',
  'na',
  'inf',
  'nan',
]);

function isConstantDefault(node: Parser.SyntaxNode): boolean {
  if (CONSTANT_DEFAULTS.has(node.type)) return true;
  // `-1`, `+2`
  return (
    node.type === 'unary_operator' &&
    ['-', '+'].includes(node.childForFieldName('operator')?.text ?? '') &&
    ['float', 'integer', 'complex', 'inf', 'nan'].includes(
      node.childForFieldName('rhs')?.type ?? '',
    )
  );
}

/** The name a plain assignment (`<-`, `=`, `<<-`, `->`, `->>`) or a `for` loop binds, or null. */
function boundName(node: Parser.SyntaxNode): string | null {
  if (node.type === 'for_statement') {
    const variable = node.childForFieldName('variable');
    return variable?.type === 'identifier' ? rBareName(variable.text) : null;
  }
  if (node.type !== 'binary_operator') return null;
  const operator = node.childForFieldName('operator')?.text;
  if (operator === undefined) return null;
  let target: Parser.SyntaxNode | null = null;
  if (operator === '<-' || operator === '=' || operator === '<<-') {
    target = node.childForFieldName('lhs');
  } else if (operator === '->' || operator === '->>') {
    target = node.childForFieldName('rhs');
  }
  return target?.type === 'identifier' ? rBareName(target.text) : null;
}

/**
 * Names bound by an assignment or `for` loop in a function's own body, one entry per function.
 * A nested function's assignments bind its own variables and are not included.
 */
const ownAssignments = new WeakMap<Parser.Tree, Map<number, ReadonlySet<string>>>();

function ownAssignedNames(fn: Parser.SyntaxNode): ReadonlySet<string> {
  let byFunction = ownAssignments.get(fn.tree);
  if (byFunction === undefined) ownAssignments.set(fn.tree, (byFunction = new Map()));
  const known = byFunction.get(fn.id);
  if (known !== undefined) return known;
  const names = new Set<string>();
  const body = fn.childForFieldName('body');
  const pending = body === null ? [] : [body];
  for (let node = pending.pop(); node !== undefined; node = pending.pop()) {
    if (node.type === 'function_definition') continue;
    const bound = boundName(node);
    if (bound !== null) names.add(bound);
    for (const child of node.namedChildren) pending.push(child);
  }
  byFunction.set(fn.id, names);
  return names;
}

/**
 * How a parameter named like a function behaves when that name is CALLED. R skips a binding
 * that is not a function when it looks up a callee, so the parameter shadows the call only if
 * it holds a function.
 *
 *  - `constant`: the default is a constant and the body never assigns the name, so the call
 *    reaches the function of that name outside;
 *  - `function`: no default and no assignment; the parameter is called, so the caller supplies
 *    a function and the call is the parameter's;
 *  - `maybe`: a function or computed default, or an assignment to the name in the body; the
 *    call may reach the parameter or the function outside, which cannot be decided statically.
 */
export type RParameterKind = 'constant' | 'function' | 'maybe';

function kindOfParameter(
  fn: Parser.SyntaxNode,
  parameter: Parser.SyntaxNode,
  name: string,
): RParameterKind {
  if (ownAssignedNames(fn).has(name)) return 'maybe';
  const dflt = parameter.childForFieldName('default');
  if (dflt === null) return 'function';
  return isConstantDefault(dflt) ? 'constant' : 'maybe';
}

function parameterNamed(fn: Parser.SyntaxNode, name: string): RParameterKind | null {
  const parameters = fn.childForFieldName('parameters');
  if (parameters === null) return null;
  for (const parameter of parameters.namedChildren) {
    if (parameter.type !== 'parameter') continue;
    const written = parameter.childForFieldName('name');
    if (written !== null && rBareName(written.text) === name) {
      return kindOfParameter(fn, parameter, name);
    }
  }
  return null;
}

/** The kind of the parameter whose name `node` is, or null when `node` is not a parameter name. */
export function rParameterKind(node: Parser.SyntaxNode): RParameterKind | null {
  const parameter = node.parent;
  if (parameter?.type !== 'parameter' || parameter.childForFieldName('name')?.id !== node.id) {
    return null;
  }
  const fn = parameter.parent?.parent;
  if (fn?.type !== 'function_definition') return null;
  return kindOfParameter(fn, parameter, rBareName(node.text));
}

/** The innermost function around `node` that has a parameter called `name`. */
function innermostParameterKind(node: Parser.SyntaxNode, name: string): RParameterKind | null {
  for (let ancestor = node.parent; ancestor !== null; ancestor = ancestor.parent) {
    if (ancestor.type !== 'function_definition') continue;
    const found = parameterNamed(ancestor, name);
    if (found !== null) return found;
  }
  return null;
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
  // A parameter of the enclosing function binds the name locally: a read of it, or a call of it
  // when it can only be a function (no default), never reaches the global.
  const local = innermostParameterKind(node, newName);
  if (local === null) return true;
  return isCallee(node) && local !== 'function';
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
    const kind = rParameterKind(node);
    if (kind === null) return 'name';
    // A parameter that cannot hold a function does not shadow a call of the same name: it is not
    // claimed, so the call is renamed with the function it reaches.
    return kind === 'constant' ? 'unrelated' : 'binding';
  },
});

export const rRenameProvider: RenameProvider = {
  canonicalName: rBareName,
  validateName(name) {
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
    // `f(x) <- v` calls the replacement function `f<-`, so a name ending in `<-` is half of a pair
    // whose other half is written differently.
    if (name.endsWith('<-') || newName.endsWith('<-'))
      return unsupported(
        'A replacement function (`name<-`) is called as `name(x) <- value`; those calls are not renamed.',
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
          (boundName(node) === newName && !insideFunction(node)) ||
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
          if (innermostParameterKind(node, name) === 'maybe')
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
    // NAMESPACE is not an indexed source, so a package function it exports (`export()`,
    // `exportPattern()`, `S3method()`) would keep a stale entry. The rename planner's graph
    // carries the indexed verdict: `isExported` is false only for a function that a NAMESPACE
    // beside the package proves private, so a package without NAMESPACE, or a node with no
    // verdict at all, is treated as exported and refused.
    const file = target.filePath;
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
    if (exported && /(^|\/)R\//.test(file))
      return unsupported(
        'A package function that NAMESPACE exports, or that the index cannot prove private, may have an export entry that is not renamed.',
      );
  },
};
