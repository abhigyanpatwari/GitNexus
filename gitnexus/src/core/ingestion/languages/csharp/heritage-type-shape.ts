import { canonicalName } from './identifiers.js';
import { typeApplicationArguments } from '../../utils/template-arguments.js';

export interface NominalName {
  name: string;
  reference?: boolean;
  projection?: 'tuple' | 'nullable';
}
const nominalTypeName =
  /^(?:global\s*::\s*)?@?[_\p{ID_Start}]\p{ID_Continue}*(?:\s*\.\s*@?[_\p{ID_Start}]\p{ID_Continue}*)*$/u;

interface NominalSpelling {
  name: string;
  nullable: boolean;
  argumentList?: string;
}

function nominalSpelling(text: string, open: number): NominalSpelling | undefined {
  const nullable = text.endsWith('?');
  const body = nullable ? text.slice(0, -1).trimEnd() : text;
  const path = open < 0 ? body : body.slice(0, open).trimEnd();
  if (!nominalTypeName.test(path)) return undefined;
  const name = path.replace(/\s+/gu, '');
  if (open < 0) return { name, nullable };
  if (!body.endsWith('>')) return undefined;
  return { name, nullable, argumentList: body.slice(open) };
}

// A scalar may still be namespace-qualified or carry a nullable suffix.
export function csharpScalarType(type: string): { name: string; nullable: boolean } | undefined {
  if (type.includes('<')) return undefined;
  return nominalSpelling(type.trim(), -1);
}

function beforeTrailingWhitespace(type: string, end: number): number {
  while (end && /\s/u.test(type.charAt(end - 1))) end--;
  return end;
}

function appendRankGroup(ranks: string[], group: string[]): void {
  for (let i = group.length - 1; i >= 0; i--) ranks.push(group[i]);
  group.length = 0;
}

// A nullable annotation terminates an array-type production. Within each production
// C# writes the outermost rank first (§17.2), so a later group wraps all earlier
// groups: T[]?[,]? has the CLR identity of T[,][].
export function csharpArraySuffix(type: string): { element: string; ranks: string[] } | undefined {
  let end = type.length;
  const ranks: string[] = [];
  const group: string[] = [];
  while (end > 0) {
    const nullable = type[end - 1] === '?';
    const pos = beforeTrailingWhitespace(type, nullable ? end - 1 : end);
    if (type[pos - 1] !== ']') break;
    const open = type.lastIndexOf('[', pos - 1);
    if (open < 0) return undefined;
    const rank = type.slice(open, pos).replace(/\s/gu, '');
    if (!/^\[,*\]$/u.test(rank)) return undefined;
    if (nullable) appendRankGroup(ranks, group);
    group.push(rank);
    end = beforeTrailingWhitespace(type, open);
  }
  if (!group.length) return undefined;
  appendRankGroup(ranks, group);
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
  /(?:(?<=[\p{ID_Continue}\s>\])?])@|(?<=[\s>\])?]))[_\p{ID_Start}\\][\p{ID_Continue}\\]*$/u;
const identifierEscape = /\\(?:u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8})/gu;

function tupleElementLabel(argument: string): RegExpExecArray | null {
  const label = trailingLabel.exec(argument);
  if (label?.[0].includes('\\') && label[0].replace(identifierEscape, '').includes('\\'))
    return null;
  return label;
}

type ResolveName = (name: string, arity: number) => NominalName | undefined;

interface TypeInfo {
  value?: boolean;
  tupleMembers?: string[];
}

function completeArguments(list: string): string[] | undefined {
  const args = typeApplicationArguments(list);
  if (!args) return undefined;
  // The shared splitter omits empty slots.
  const contents = list.slice(1, -1).replace(/\s+/gu, '');
  return args.join(',').replace(/\s+/gu, '') === contents ? args : undefined;
}

function projectedSpelling(
  name: NominalName,
  rendered: string[],
  inner: TypeInfo | undefined,
  annotated: boolean,
  info?: TypeInfo,
): string | undefined {
  if (name.projection === 'nullable' && inner?.value) {
    if (info) info.value = false;
    return rendered[0] + '?';
  }
  if (name.projection !== 'tuple') return undefined;
  let members = rendered;
  if (rendered.length >= 8) {
    if (!inner?.tupleMembers) return undefined;
    members = [...rendered.slice(0, 7), ...inner.tupleMembers];
  }
  if (info && !annotated) info.tupleMembers = members;
  // ValueTuple<T> represents the tail of a long tuple. C# has no standalone
  // one-element tuple syntax.
  if (members.length < 2) return undefined;
  return '(' + members.join(',') + ')' + (annotated ? '?' : '');
}

class CsharpTypeRenderer {
  constructor(
    private readonly resolveName: ResolveName,
    private readonly preserveRankBoundaries: boolean,
    private readonly tupleElements?: TupleElements,
  ) {}

  render(spelling: string, depth = 0, offset = 0, info?: TypeInfo): string | undefined {
    if (depth > 64) return undefined;
    const text = spelling.trim();
    if (this.tupleElements) offset += spelling.indexOf(text);
    const array = (text.endsWith(']') || text.endsWith('?')) && csharpArraySuffix(text);
    if (array) {
      const element = this.render(array.element, depth + 1, offset);
      // During substitution every rank is its own reference-annotated production.
      // Appending a formal's outer rank then wraps an array-valued actual.
      if (this.preserveRankBoundaries) {
        array.ranks.reverse();
        return element && element + array.ranks.join('?') + '?';
      }
      return element && element + array.ranks.join('');
    }
    const tuple = text.startsWith('(') && /^\(([\s\S]*)\)\s*(\?)?$/u.exec(text);
    if (tuple) return this.renderTuple(text, tuple, depth, offset, info);
    return this.renderNominal(text, depth, offset, info);
  }

  private renderTuple(
    text: string,
    tuple: RegExpExecArray,
    depth: number,
    offset: number,
    info?: TypeInfo,
  ): string | undefined {
    const args = completeArguments('<' + tuple[1] + '>');
    if (!args || args.length < 2) return undefined;
    const annotated = Boolean(tuple[2]);
    if (info) info.value = !annotated;
    const rendered = this.renderArguments(text, args, true, depth, offset);
    if (!rendered) return undefined;
    if (info && !annotated) info.tupleMembers = rendered;
    return '(' + rendered.join(',') + ')' + (annotated ? '?' : '');
  }

  private renderNominal(
    text: string,
    depth: number,
    offset: number,
    info?: TypeInfo,
  ): string | undefined {
    const nominal = nominalSpelling(text, text.indexOf('<'));
    if (!nominal) return undefined;
    const args = nominal.argumentList ? completeArguments(nominal.argumentList) : undefined;
    if (nominal.argumentList && !args) return undefined;
    const { resolveName } = this;
    const name = resolveName(nominal.name, args?.length ?? 0);
    if (!name) return undefined;
    const annotated = nominal.nullable && !name.reference;
    if (info) info.value = !annotated && name.reference === false;
    const suffix = annotated ? '?' : '';
    if (!args) return name.name + suffix;

    // Only Nullable's operand and the Rest of an eight-slot ValueTuple need
    // to return their value/tuple identity in addition to the rendered spelling.
    const needsInner =
      (name.projection === 'nullable' && args.length === 1) ||
      (name.projection === 'tuple' && args.length === 8);
    const inner: TypeInfo | undefined = needsInner ? {} : undefined;
    const rendered = this.renderArguments(text, args, false, depth, offset, inner);
    if (!rendered) return undefined;
    return (
      projectedSpelling(name, rendered, inner, annotated, info) ??
      name.name + '<' + rendered.join(',') + '>' + suffix
    );
  }

  private renderArguments(
    text: string,
    args: readonly string[],
    tuple: boolean,
    depth: number,
    offset: number,
    inner?: TypeInfo,
  ): string[] | undefined {
    const rendered: string[] = [];
    let position = 1;
    if (this.tupleElements && !tuple) position = text.indexOf('<') + 1;
    for (let i = 0; i < args.length; i++) {
      const argument = args[i];
      let start = 0;
      if (this.tupleElements) {
        start = text.indexOf(argument, position);
        if (start < 0) return undefined;
        position = start + argument.length;
      }
      const value = this.renderArgument(
        argument,
        tuple,
        depth + 1,
        offset + start,
        i === args.length - 1 ? inner : undefined,
      );
      if (!value) return undefined;
      rendered.push(value);
    }
    return rendered;
  }

  private renderArgument(
    argument: string,
    tuple: boolean,
    depth: number,
    offset: number,
    info?: TypeInfo,
  ): string | undefined {
    if (!tuple) return this.render(argument, depth, offset, info);
    const label = tupleElementLabel(argument);
    this.tupleElements?.visit(
      label ? canonicalName(label[0]) : undefined,
      offset + (label?.index ?? 0),
      label?.[0].length ?? 0,
    );
    const operand = label ? argument.slice(0, label.index) : argument;
    const value = this.render(operand, depth, offset, info);
    if (!value || !label || this.tupleElements?.omitLabels) return value;
    return value + ' ' + label[0];
  }
}

/** CLR comparison spelling for named, constructed, array and tuple types. */
export function renderCsharpHeritageType(
  type: string,
  resolveName: ResolveName = (name) => ({ name }),
  preserveRankBoundaries = false,
  tupleElements?: TupleElements,
): string | undefined {
  return new CsharpTypeRenderer(resolveName, preserveRankBoundaries, tupleElements).render(type);
}
