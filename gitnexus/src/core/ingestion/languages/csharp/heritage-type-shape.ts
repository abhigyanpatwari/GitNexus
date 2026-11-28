import { canonicalName } from './identifiers.js';
import { typeApplicationArguments } from '../../utils/template-arguments.js';

export interface NominalName {
  name: string;
  reference?: boolean;
  projection?: 'tuple' | 'nullable';
}
const nominalType =
  /^((?:global\s*::\s*)?@?[_\p{ID_Start}][_\p{ID_Continue}]*(?:\s*\.\s*@?[_\p{ID_Start}][_\p{ID_Continue}]*)*)(?:\s*(<[\s\S]*>))?\s*(\?)?$/u;

// A scalar may still be namespace-qualified or carry a nullable suffix.
export function csharpScalarType(type: string): { name: string; nullable: boolean } | undefined {
  if (type.includes('<')) return undefined;
  const match = nominalType.exec(type.trim());
  return match ? { name: match[1].replace(/\s+/gu, ''), nullable: Boolean(match[3]) } : undefined;
}

// A nullable annotation terminates an array-type production. Within each production
// C# writes the outermost rank first (§17.2), so a later group wraps all earlier
// groups: T[]?[,]? has the CLR identity of T[,][].
export function csharpArraySuffix(type: string): { element: string; ranks: string[] } | undefined {
  let end = type.length;
  const ranks: string[] = [];
  let group: string[] = [];
  while (end > 0) {
    let pos = end;
    const nullable = type[pos - 1] === '?';
    if (nullable) pos--;
    while (pos && /\s/u.test(type.charAt(pos - 1))) pos--;
    if (type[pos - 1] !== ']') break;
    const open = type.lastIndexOf('[', pos - 1);
    if (open < 0) return undefined;
    const rank = type.slice(open, pos).replace(/\s/gu, '');
    if (!/^\[,*\]$/u.test(rank)) return undefined;
    if (nullable && group.length) {
      for (const item of group.reverse()) ranks.push(item);
      group = [];
    }
    group.push(rank);
    end = open;
    while (end && /\s/u.test(type.charAt(end - 1))) end--;
  }
  if (!group.length) return undefined;
  for (const item of group.reverse()) ranks.push(item);
  return { element: type.slice(0, end), ranks };
}

export const csharpParameterMode = /^(?:ref|out|in|this)\s+/u;

interface TupleElements {
  visit(label: string | undefined, offset: number, length: number): void;
  omitLabels?: boolean;
}

// Read an identifier only in a tuple-element name position. The preceding slice
// must independently parse as a complete type (including nested tuples/arrays).
// Anchor the start at a token boundary so an unnamed long identifier is scanned
// once. A verbatim identifier may immediately follow a type (int@name).
const trailingLabel =
  /((?:(?<=[\p{ID_Continue}\s>\])?])@|(?<=[\s>\])?]))(?:[_\p{ID_Start}]|\\u[0-9a-fA-F]{4}|\\U[0-9a-fA-F]{8})(?:[_\p{ID_Continue}]|\\u[0-9a-fA-F]{4}|\\U[0-9a-fA-F]{8})*)$/u;
/** CLR comparison spelling for named, constructed, array and tuple types. */
export function renderCsharpHeritageType(
  type: string,
  resolveName: (name: string, arity: number) => NominalName | undefined = (name) => ({ name }),
  preserveRankBoundaries = false,
  tupleElements?: TupleElements,
): string | undefined {
  interface TypeInfo {
    value?: boolean;
    tupleMembers?: string[];
  }
  const render = (
    spelling: string,
    depth: number,
    offset: number,
    info?: TypeInfo,
  ): string | undefined => {
    if (depth > 64) return undefined;
    const text = spelling.trim();
    if (tupleElements) offset += spelling.indexOf(text);
    const array = (text.endsWith(']') || text.endsWith('?')) && csharpArraySuffix(text);
    if (array) {
      const element = render(array.element, depth + 1, offset);
      // During substitution every rank is its own (reference-annotated) production.
      // Appending a formal's outer rank then wraps an array-valued actual without
      // reversing their order. The final comparison omits these annotations.
      const suffix = preserveRankBoundaries
        ? array.ranks.reverse().join('?') + '?'
        : array.ranks.join('');
      return element && element + suffix;
    }
    const tuple = text.startsWith('(') && /^\(([\s\S]*)\)\s*(\?)?$/u.exec(text);
    const nominal = tuple ? undefined : nominalType.exec(text);
    if (!nominal && !tuple) return undefined;
    const list = tuple ? '<' + tuple[1] + '>' : nominal?.[2];
    const args = list ? typeApplicationArguments(list) : undefined;
    // The shared splitter omits empty slots. An unnamed tuple also needs two elements.
    if (
      list &&
      (!args ||
        (tuple && args.length < 2) ||
        args.join(',').replace(/\s+/gu, '') !== list.slice(1, -1).replace(/\s+/gu, ''))
    )
      return undefined;
    const name = nominal && resolveName(nominal[1].replace(/\s+/gu, ''), args?.length ?? 0);
    if (nominal && !name) return undefined;
    let result = name?.name ?? '';
    const annotated = tuple ? tuple[2] : nominal?.[3] && !name?.reference;
    if (info) info.value = !annotated && (Boolean(tuple) || name?.reference === false);
    if (args) {
      const rendered: string[] = [];
      // Only projected constructors need the identity of an argument in addition
      // to its spelling: Nullable's operand or the Rest of an eight-slot tuple.
      const inner: TypeInfo | undefined =
        (name?.projection === 'nullable' && args.length === 1) ||
        (name?.projection === 'tuple' && args.length === 8)
          ? {}
          : undefined;
      let position = tupleElements ? (tuple ? 1 : text.indexOf('<') + 1) : 0;
      for (const arg of args) {
        let start = 0;
        if (tupleElements) {
          start = text.indexOf(arg, position);
          if (start < 0) return undefined;
          position = start + arg.length;
        }
        let operand = arg;
        let label: RegExpExecArray | null = null;
        if (tuple) {
          const tail = trailingLabel.exec(arg);
          if (tail) {
            label = tail;
            operand = arg.slice(0, tail.index);
          }
          tupleElements?.visit(
            label ? canonicalName(label[1]) : undefined,
            offset + start + (label?.index ?? 0),
            label?.[1].length ?? 0,
          );
        }
        const value = render(
          operand,
          depth + 1,
          offset + start,
          rendered.length === args.length - 1 ? inner : undefined,
        );
        if (!value) return undefined;
        rendered.push(label && !tupleElements?.omitLabels ? value + ' ' + label[1] : value);
      }
      if (name?.projection === 'nullable' && inner?.value) {
        if (info) info.value = false;
        return rendered[0] + '?';
      }
      if (tuple && info && !annotated) info.tupleMembers = rendered;
      if (name?.projection === 'tuple') {
        const members =
          rendered.length < 8
            ? rendered
            : inner?.tupleMembers && [...rendered.slice(0, 7), ...inner.tupleMembers];
        if (members) {
          if (info && !annotated) info.tupleMembers = members;
          // ValueTuple<T> represents the tail of a long tuple. C# has no
          // one-element tuple syntax when it appears as a standalone type.
          if (members.length > 1) return '(' + members.join(',') + ')' + (annotated ? '?' : '');
        }
      }
      result += (tuple ? '(' : '<') + rendered.join(',') + (tuple ? ')' : '>');
    }
    return annotated ? result + '?' : result;
  };
  return render(type, 0, 0);
}
