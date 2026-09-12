import type { ParsedFile, Range, SymbolDefinition } from 'gitnexus-shared';

/**
 * A generic Go interface's type-parameter names, in DECLARATION ORDER, stamped
 * onto its `Interface` def as a Go-private sidecar.
 *
 * Same mechanism and lifecycle as `goReceiverKind` (method-owners.ts): an extra
 * property on a def the Go resolver owns, written on the main thread and read by
 * `interface-impls.ts`. It is deliberately NOT a shared `SymbolDefinition` field
 * and deliberately NOT a capture — see {@link stampGoInterfaceTypeParameters}.
 *
 * ORDER IS THE POINT. Substitution is positional (`Repo[User]` binds the FIRST
 * type parameter), so a set or a name→constraint map would lose exactly the
 * information this exists to carry.
 */
type GoGenericInterfaceDefinition = SymbolDefinition & {
  readonly goTypeParameters?: readonly string[];
};

/**
 * Stamp every generic interface in `parsedFiles` with its type-parameter names,
 * read out of the declaration's own source text.
 *
 * WHY SOURCE TEXT AND NOT A CAPTURE. The tree has the list right there
 * (`type_spec` carries a `type_parameters` field), and capturing it would be two
 * lines. But captures run inside the PARSE WORKER, whose script is resolved from
 * the compiled `dist/` build, and their output is additionally memoized by the
 * parse cache and the durable ParsedFile store — so a capture-side change is
 * invisible until a rebuild AND a cache-version bump, and silently wrong in
 * between. Everything here runs on the main thread from data the pipeline
 * already materialized, so it is correct on the first run and needs neither.
 *
 * The scan is exact rather than a grep over the file: an interface declaration
 * owns a `Class` scope whose range spans exactly its `type_spec`
 * (`Repo[T any] interface{ … }`), so the text is sliced by that range and the
 * type parameters are, by grammar, whatever sits between the brackets that
 * IMMEDIATELY follow the name. Comments and strings elsewhere in the file cannot
 * reach it.
 */
export function stampGoInterfaceTypeParameters(
  parsedFiles: readonly ParsedFile[],
  fileContents: ReadonlyMap<string, string>,
): void {
  for (const parsed of parsedFiles) {
    // Deferred so a file with no interface declaration never indexes its lines.
    let lines: { readonly source: string; readonly starts: readonly number[] } | undefined;
    for (const scope of parsed.scopes) {
      if (scope.kind !== 'Class') continue;
      const iface = scope.ownedDefs.find((def) => def.type === 'Interface');
      if (iface?.qualifiedName === undefined) continue;
      if (lines === undefined) {
        const source = fileContents.get(parsed.filePath);
        if (source === undefined) break;
        lines = { source, starts: buildLineStarts(source) };
      }
      const declaration = sliceRange(lines.source, lines.starts, scope.range);
      if (declaration === undefined) continue;
      const names = goTypeParameterNames(declaration, simpleGoName(iface.qualifiedName));
      if (names === undefined) continue;
      (iface as { goTypeParameters?: readonly string[] }).goTypeParameters = names;
    }
  }
}

/** Read back a stamp, rejecting anything whose shape does not match — the
 *  sidecar is optional and a hand-built fixture def carries none. */
export function readGoTypeParameters(def: SymbolDefinition): readonly string[] | undefined {
  const names = (def as GoGenericInterfaceDefinition).goTypeParameters;
  if (!Array.isArray(names) || names.length === 0) return undefined;
  return names.every((name): name is string => typeof name === 'string') ? names : undefined;
}

/**
 * The declared type-parameter names of `Name[…] interface{…}`, in source order,
 * or `undefined` when the declaration is not generic.
 *
 * Go spec, Type parameter declarations: the list is comma-separated and one
 * entry may declare SEVERAL names sharing one constraint — `[K, V any]` declares
 * `K` and `V`, and `[S ~[]E, E any]` declares `S` and `E`. Each entry therefore
 * contributes exactly its FIRST token as a name; anything after it is the
 * constraint, which is not needed here (satisfaction of a constraint is a
 * separate question from implementation of an interface, and constraints are
 * never harvested as instantiations — see `interface-impls.ts`).
 */
function goTypeParameterNames(declaration: string, interfaceName: string): string[] | undefined {
  if (!declaration.startsWith(interfaceName)) return undefined;
  if (declaration[interfaceName.length] !== '[') return undefined;
  const close = matchingGoDelimiter(declaration, interfaceName.length);
  if (close === -1) return undefined;
  const names: string[] = [];
  for (const entry of splitTopLevelGoList(declaration.slice(interfaceName.length + 1, close))) {
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(entry)?.[0];
    if (name === undefined) return undefined;
    names.push(name);
  }
  return names.length === 0 ? undefined : names;
}

/** Index of the delimiter closing the one at `open`, or -1 when unbalanced.
 *  Tracks `[]`, `{}` and `()` together so an `interface{ M(a, b int) }`
 *  constraint cannot end the list early. */
export function matchingGoDelimiter(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '[' || ch === '{' || ch === '(') depth += 1;
    else if (ch === ']' || ch === '}' || ch === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Split on commas that are not nested inside brackets, braces or parens. */
export function splitTopLevelGoList(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === '[' || ch === '{' || ch === '(') depth += 1;
    else if (ch === ']' || ch === '}' || ch === ')') depth -= 1;
    else if (ch === ',' && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function simpleGoName(qualifiedName: string): string {
  const dot = qualifiedName.lastIndexOf('.');
  return dot === -1 ? qualifiedName : qualifiedName.slice(dot + 1);
}

/** Offsets at which each 1-based line begins. */
function buildLineStarts(source: string): number[] {
  const starts = [0, 0];
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === '\n') starts.push(i + 1);
  }
  return starts;
}

/** `Range` is 1-based on lines and 0-based on columns (`syntheticCapture`). */
function sliceRange(
  source: string,
  lineStarts: readonly number[],
  range: Range,
): string | undefined {
  const start = lineStarts[range.startLine];
  const end = lineStarts[range.endLine];
  if (start === undefined || end === undefined) return undefined;
  return source.slice(start + range.startCol, end + range.endCol);
}
