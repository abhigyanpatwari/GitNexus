import { canonicalName } from './identifiers.js';
import { typeApplicationArguments } from '../../utils/template-arguments.js';

export interface NominalName {
  name: string;
  reference?: boolean;
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
function arraySuffix(type: string): { element: string; ranks: string[] } | undefined {
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
  resolveName: (name: string) => NominalName | undefined = (name) => ({ name }),
  preserveRankBoundaries = false,
  tupleElements?: TupleElements,
): string | undefined {
  const render = (spelling: string, depth: number, offset: number): string | undefined => {
    if (depth > 64) return undefined;
    const text = spelling.trim();
    if (tupleElements) offset += spelling.indexOf(text);
    const array = (text.endsWith(']') || text.endsWith('?')) && arraySuffix(text);
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
    const name = nominal && resolveName(nominal[1].replace(/\s+/gu, ''));
    if (nominal && !name) return undefined;
    let result = name?.name ?? '';
    const list = tuple ? '<' + tuple[1] + '>' : nominal?.[2];
    if (list) {
      const args = typeApplicationArguments(list);
      // The shared splitter omits empty slots. An unnamed tuple also needs two elements.
      if (
        !args ||
        (tuple && args.length < 2) ||
        args.join(',').replace(/\s+/gu, '') !== list.slice(1, -1).replace(/\s+/gu, '')
      )
        return undefined;
      const rendered: string[] = [];
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
        const value = render(operand, depth + 1, offset + start);
        if (!value) return undefined;
        rendered.push(label && !tupleElements?.omitLabels ? value + ' ' + label[1] : value);
      }
      result += (tuple ? '(' : '<') + rendered.join(',') + (tuple ? ')' : '>');
    }
    return (tuple ? tuple[2] : nominal?.[3] && !name?.reference) ? result + '?' : result;
  };
  return render(type, 0, 0);
}
