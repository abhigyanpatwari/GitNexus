import { XMLParser, XMLValidator, type XMLMetaData } from 'fast-xml-parser';
import type { DocumentDeclaration } from './types.js';

const XAML_NAMESPACE = 'http://schemas.microsoft.com/winfx/2006/xaml';
const DIRECTIVES = new Set(['Name', 'Key', 'Class']);
const META = XMLParser.getMetaDataSymbol() as symbol;
type XmlNode = Record<string, unknown> & { [key: symbol]: XMLMetaData | undefined };

export function extractXamlDeclarations(source: string): DocumentDeclaration[] {
  // fast-xml-parser normalizes newlines before computing its metadata offsets.
  source = source.replace(/\r\n?/g, '\n');
  // Repository documents are untrusted. Never resolve DTDs or expand entities.
  if (/<!DOCTYPE\b/i.test(source)) throw new Error('DTD declarations are not supported');
  if (XMLValidator.validate(source) !== true) {
    throw new Error('Invalid XML');
  }
  const parser = new XMLParser({
    preserveOrder: true,
    ignoreAttributes: false,
    captureMetaData: true,
    processEntities: false,
    parseAttributeValue: false,
    trimValues: false,
    ignoreDeclaration: true,
    ignorePiTags: true,
    maxNestedTags: 100,
  });
  // This is fast-xml-parser, not tree-sitter; its API accepts XML text,
  // not the chunked input callback supplied by parseSourceSafe.
  // eslint-disable-next-line gitnexus/require-safe-parse
  const roots = parser.parse(source) as XmlNode[];
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === '\r') {
      if (source[i + 1] === '\n') i++;
      lineStarts.push(i + 1);
    } else if (source[i] === '\n') lineStarts.push(i + 1);
  }
  const lineAt = (offset: number): number => {
    let lo = 0;
    let hi = lineStarts.length;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >>> 1;
      if (lineStarts[mid] <= offset) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  const declarations: DocumentDeclaration[] = [];
  const stack = roots
    .map((node) => ({ node, namespaces: new Map<string, string>(), level: 1 }))
    .reverse();
  while (stack.length) {
    const { node, namespaces: inherited, level } = stack.pop()!;
    const tag = Object.keys(node).find((key) => key !== ':@' && !key.startsWith('#'));
    if (!tag || !Array.isArray(node[tag])) continue;
    if (level > 100) throw new Error('Maximum document depth exceeded');
    const attributes = Object.entries((node[':@'] ?? {}) as Record<string, string>);
    const namespaceAttributes = attributes.filter(([key]) => key.startsWith('@_xmlns:'));
    const namespaces = namespaceAttributes.length ? new Map(inherited) : inherited;
    for (const [key, value] of namespaceAttributes) namespaces.set(key.slice(8), value);
    const span = node[META];
    for (const [attribute, value] of attributes) {
      const parts = attribute.slice(2).split(':');
      if (
        parts.length !== 2 ||
        namespaces.get(parts[0]) !== XAML_NAMESPACE ||
        !DIRECTIVES.has(parts[1])
      )
        continue;
      if (typeof value !== 'string' || !value.trim() || /[{}&]/.test(value)) continue;
      if (span?.startIndex === undefined || span.endIndex === undefined) continue;
      declarations.push({
        name: value,
        description: `${tag} x:${parts[1]} declaration`,
        startIndex: span.startIndex,
        startLine: lineAt(span.startIndex),
        endLine: lineAt(Math.max(span.startIndex, span.endIndex - 1)),
        level,
      });
    }
    const children = node[tag] as XmlNode[];
    for (let i = children.length - 1; i >= 0; i--) {
      stack.push({ node: children[i], namespaces, level: level + 1 });
    }
  }
  return declarations;
}
