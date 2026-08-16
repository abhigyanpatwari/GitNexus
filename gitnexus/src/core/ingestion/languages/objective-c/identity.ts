import type { SyntaxNode } from '../../utils/ast-helpers.js';

export type ObjectiveCSourceRole =
  | 'declaration'
  | 'implementation'
  | 'category-host'
  | 'forward-declaration'
  | 'synthesized';

export interface ObjectiveCContainerIdentity {
  readonly owner: string;
  readonly category: string | null;
  readonly declarationScope: '<primary>' | string;
  readonly sourceRole: ObjectiveCSourceRole;
  readonly isCategory: boolean;
  readonly isClassExtension: boolean;
}

function normalized(value: string): string {
  return value.normalize('NFC');
}

/** Deterministic, delimiter-safe key used by Objective-C source-site metadata. */
export function objectiveCKeyV1(parts: readonly string[]): string {
  return `objc:v1:${JSON.stringify(parts.map(normalized))}`;
}

export function objectiveCSourceIdentity(input: {
  readonly label: string;
  readonly owner: string;
  readonly declarationScope: string;
  readonly sourceRole: ObjectiveCSourceRole;
  readonly member: string;
}): string {
  return objectiveCKeyV1([
    'source',
    input.label,
    input.owner,
    input.declarationScope,
    input.sourceRole,
    input.member,
  ]);
}

/** Source-site identity for selector literals, which may repeat within one owner. */
export function objectiveCSelectorSourceIdentity(
  input: {
    readonly owner: string;
    readonly sourceRole: ObjectiveCSourceRole;
    readonly member: string;
  },
  node: SyntaxNode,
): string {
  return objectiveCKeyV1([
    'source',
    'CodeElement',
    input.owner,
    '<selector>',
    input.sourceRole,
    input.member,
    'site',
    `${node.startPosition.row}:${node.startPosition.column}`,
    `${node.endPosition.row}:${node.endPosition.column}`,
  ]);
}

const MAX_SELECTOR_LITERAL_LENGTH = 4_096;
const SELECTOR_IDENTIFIER = /[$_\p{ID_Start}][$\p{ID_Continue}\u200C\u200D]*/uy;

function selectorTokens(body: string): readonly string[] | null {
  // C translation removes escaped newlines before comments are recognized.
  const source = body.replace(/\\(?:\r\n|[\r\n])/g, '');
  const tokens: string[] = [];
  let cursor = 0;

  while (cursor < source.length) {
    if (/\s/u.test(source[cursor] ?? '')) {
      cursor += 1;
      continue;
    }
    if (source.startsWith('/*', cursor)) {
      const end = source.indexOf('*/', cursor + 2);
      if (end === -1) return null;
      cursor = end + 2;
      continue;
    }
    if (source.startsWith('//', cursor)) {
      const end = source.slice(cursor + 2).search(/[\r\n]/u);
      if (end === -1) return null;
      cursor += end + 2;
      continue;
    }
    if (source[cursor] === ':') {
      tokens.push(':');
      cursor += 1;
      continue;
    }

    SELECTOR_IDENTIFIER.lastIndex = cursor;
    const identifier = SELECTOR_IDENTIFIER.exec(source);
    if (identifier === null) return null;
    tokens.push(identifier[0]!.normalize('NFC'));
    cursor = SELECTOR_IDENTIFIER.lastIndex;
  }
  return tokens;
}

export function objectiveCSelectorName(node: SyntaxNode): string | null {
  if (node.type !== 'selector_expression') return null;
  const text = node.text.trim();
  if (text.length > MAX_SELECTOR_LITERAL_LENGTH || !text.startsWith('@selector')) return null;

  let openParen = '@selector'.length;
  while (openParen < text.length) {
    if (/\s/u.test(text[openParen] ?? '')) {
      openParen += 1;
      continue;
    }
    if (text[openParen] === '\\') {
      const newline = /^(?:\r\n|[\r\n])/u.exec(text.slice(openParen + 1));
      if (newline !== null) {
        openParen += newline[0].length + 1;
        continue;
      }
    }
    if (text.startsWith('/*', openParen)) {
      const end = text.indexOf('*/', openParen + 2);
      if (end === -1) return null;
      openParen = end + 2;
      continue;
    }
    if (text.startsWith('//', openParen)) {
      const end = text.slice(openParen + 2).search(/[\r\n]/u);
      if (end === -1) return null;
      openParen += end + 2;
      continue;
    }
    break;
  }
  if (text[openParen] !== '(' || !text.endsWith(')')) return null;

  const tokens = selectorTokens(text.slice(openParen + 1, -1));
  if (tokens === null || tokens.length === 0) return null;

  if (!tokens.includes(':')) {
    return tokens.length === 1 ? tokens[0]! : null;
  }
  for (let index = 0; index < tokens.length; ) {
    if (tokens[index] !== ':') index += 1;
    if (tokens[index] !== ':') return null;
    index += 1;
  }
  return tokens.join('');
}

function directIdentifier(node: SyntaxNode): SyntaxNode | undefined {
  return node.namedChildren.find((child) => child.type === 'identifier');
}

/** Identify the logical Objective-C owner/category represented by a type container. */
export function objectiveCContainerIdentity(node: SyntaxNode): ObjectiveCContainerIdentity | null {
  if (
    node.type !== 'class_interface' &&
    node.type !== 'class_implementation' &&
    node.type !== 'protocol_declaration'
  ) {
    return null;
  }

  const owner = directIdentifier(node)?.text;
  if (owner === undefined) return null;
  const category = node.childForFieldName('category')?.text ?? null;
  const hasCategoryParens = node.children.some((child) => child.text === '(');
  const isCategory = category !== null;
  const isClassExtension = category === null && hasCategoryParens;
  const sourceRole: ObjectiveCSourceRole =
    node.type === 'class_implementation' ? 'implementation' : 'declaration';

  return {
    owner,
    category,
    declarationScope: isCategory ? category : '<primary>',
    sourceRole,
    isCategory,
    isClassExtension,
  };
}

export function objectiveCCategoryDisplayName(identity: ObjectiveCContainerIdentity): string {
  return `${identity.owner}(${identity.category ?? '<extension>'})`;
}

/** Physical source scope; class extensions stay logically primary but need distinct source ids. */
export function objectiveCSourceScope(identity: ObjectiveCContainerIdentity): string {
  return identity.isClassExtension ? '<extension>' : identity.declarationScope;
}

export function objectiveCBlockName(node: SyntaxNode): string {
  return `block@${node.startPosition.row + 1}:${node.startPosition.column + 1}`;
}
