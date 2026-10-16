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

/** One escape, longest form first: octal, hex/unicode, then any other `\c`. */
const ESCAPE =
  /\\(?:([0-7]{1,3})|(x[0-9A-Fa-f]{1,2}|u\{[0-9A-Fa-f]{1,4}\}|u[0-9A-Fa-f]{1,4}|U\{[0-9A-Fa-f]{1,8}\}|U[0-9A-Fa-f]{1,8})|([\s\S]))/g;

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
  return text
    .slice(1, -1)
    .replace(ESCAPE, (_m, octal?: string, coded?: string, other?: string) =>
      octal !== undefined
        ? String.fromCharCode(parseInt(octal, 8) & 0xff)
        : unescapeRString(`\\${coded ?? other ?? ''}`),
    );
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

/** The name a `<<-` or `->>` assignment writes to (backticks removed), or null for any other node. */
function superassignedName(node: Parser.SyntaxNode): string | null {
  if (node.type !== 'binary_operator') return null;
  const operator = node.childForFieldName('operator')?.text;
  if (operator !== '<<-' && operator !== '->>') return null;
  const target = node.childForFieldName(operator === '<<-' ? 'lhs' : 'rhs');
  return target?.type === 'identifier' ? rBareName(target.text) : null;
}

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
  role: (node) =>
    node.parent?.type === 'parameter' && node.parent.childForFieldName('name')?.id === node.id
      ? 'binding'
      : 'name',
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
    const defined = new Set(
      [...files.values()].flatMap((source) =>
        source.parsed.localDefs.flatMap((d) =>
          d.qualifiedName === undefined ? [] : [rBareName(d.qualifiedName)],
        ),
      ),
    );
    if (registersS3Method(newName, defined))
      return unsupported(
        'The new name would register an S3 method of an existing function or base generic.',
      );
    for (const source of files.values()) {
      if (!source.tree) continue;
      for (const node of walkNamedNodes(source.tree.rootNode)) {
        // `name <<- value` (inside a function or not) is a global re-definition that the
        // scope graph keeps as a separate declaration, so a rename would leave it behind.
        if (superassignedName(node) === name)
          return {
            code: 'ambiguous_reference',
            message:
              'This name is also assigned with <<- or ->>; the global re-assignment is not renamed with it.',
          };
        if (node.type !== 'string') continue;
        const value = rStringValue(node.text);
        if (value !== null && (value === name || value === newName))
          return unsupported(
            'A string literal spells this name; S3, S4, R6 and dynamic lookup resolve it by string.',
          );
      }
    }
    // NAMESPACE is not an indexed source. A package function that the NAMESPACE
    // exports (the graph keeps isExported unless it is proven private) is refused.
    const file = target.filePath;
    let exported = false;
    graph.forEachNode((node) => {
      if (
        node.properties.filePath === file &&
        typeof node.properties.name === 'string' &&
        rBareName(node.properties.name) === name &&
        node.properties.isExported !== false
      )
        exported = true;
    });
    if (exported && /(^|\/)R\//.test(file))
      return unsupported(
        'A package function may have a NAMESPACE export entry that is not renamed.',
      );
  },
};
