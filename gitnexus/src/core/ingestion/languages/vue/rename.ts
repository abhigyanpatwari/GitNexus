import type { RenameOccurrence, RenameProvider, RenameSource } from '../../rename-provider.js';
import { SupportedLanguages, type Range, type Scope, type ReferenceSite } from 'gitnexus-shared';
import { emitTsScopeCaptures } from '../typescript/captures.js';
import { typescriptRenameProvider } from '../typescript/rename.js';
import { getTsParser } from '../typescript/query.js';
import type Parser from 'tree-sitter';
import { parseSourceSafe } from '../../../tree-sitter/safe-parse.js';

interface Tag {
  readonly start: number;
  readonly end: number;
  readonly name: string;
  readonly nameStart: number;
  readonly closing: boolean;
  readonly selfClosing: boolean;
  readonly attributes: readonly Attribute[];
}

interface Attribute {
  readonly name: string;
  readonly nameStart: number;
  readonly value?: string;
  readonly start?: number;
}

const unsupported = (message: string): never => {
  throw Object.assign(new Error(message), { code: 'unsupported_source', status: 'unsupported' });
};

/** SFC markup lexer. Quoted values and raw script/style bodies are never scanned as tags. */
function tagAt(content: string, start: number): Tag | undefined {
  const head = /^<(\/)?([A-Za-z][\w:.-]*)/.exec(content.slice(start));
  if (!head) return undefined;
  let cursor = start + head[0].length;
  const boundary = content[cursor];
  if (boundary !== undefined && !/[\s/>]/.test(boundary)) unsupported('Unsupported Vue tag name.');
  const attributes: Attribute[] = [];
  while (cursor < content.length) {
    while (/\s/.test(content[cursor] ?? '') && cursor < content.length) cursor++;
    if (content[cursor] === '>' || content.slice(cursor, cursor + 2) === '/>') {
      const selfClosing = content[cursor] === '/';
      return {
        start,
        end: cursor + (selfClosing ? 2 : 1),
        name: head[2]!,
        nameStart: start + (head[1] ? 2 : 1),
        closing: !!head[1],
        selfClosing,
        attributes,
      };
    }
    const attribute = /^[^\s=/>]+/.exec(content.slice(cursor));
    if (!attribute) unsupported('Cannot establish the Vue template attribute boundaries.');
    const name = attribute![0];
    const nameStart = cursor;
    cursor += name.length;
    while (/\s/.test(content[cursor] ?? '') && cursor < content.length) cursor++;
    if (content[cursor] !== '=') {
      attributes.push({ name, nameStart });
      continue;
    }
    cursor++;
    while (/\s/.test(content[cursor] ?? '') && cursor < content.length) cursor++;
    const quote = content[cursor];
    if (quote !== '"' && quote !== "'") {
      const value = /^[^\s>]+/.exec(content.slice(cursor));
      if (!value) unsupported('Cannot establish the Vue attribute value.');
      attributes.push({ name, nameStart, value: value![0], start: cursor });
      cursor += value![0].length;
      continue;
    }
    const valueStart = ++cursor;
    const end = content.indexOf(quote!, cursor);
    if (end < 0) unsupported('Unclosed Vue attribute value.');
    attributes.push({ name, nameStart, value: content.slice(valueStart, end), start: valueStart });
    cursor = end + 1;
  }
  return unsupported('Unclosed Vue tag.');
}

interface Projection {
  readonly text: string;
  readonly templateRanges: readonly { start: number; end: number; scope?: TemplateScope }[];
  readonly scopes: readonly TemplateScope[];
  readonly setup: boolean;
  readonly jsx: boolean;
  readonly componentTags: readonly {
    start: number;
    end: number;
    name: string;
    kebab: boolean;
    scope?: TemplateScope;
  }[];
  readonly shorthandAttributes: readonly number[];
}

interface TemplateScope {
  readonly start: number;
  end: number;
  readonly parent?: TemplateScope;
  readonly bindings: readonly { name: string; start: number; synthetic?: boolean }[];
  readonly deferred?: boolean;
}

const VOID_TAGS = new Set(
  'area base br col embed hr img input link meta param source track wbr'.split(' '),
);
const BUILTIN_TAGS = new Set(
  'router-view router-link transition transition-group keep-alive teleport suspense component slot'.split(
    ' ',
  ),
);
type VueOccurrence = RenameOccurrence & {
  readonly templateTag?: 'pascal' | 'kebab';
  readonly shorthandAttribute?: boolean;
};

function templateBindings(pattern: string, start: number): { name: string; start: number }[] {
  let leading = pattern.length - pattern.trimStart().length;
  let text = pattern.trim();
  if (text.startsWith('(') && text.endsWith(')')) {
    text = text.slice(1, -1);
    leading++;
  }
  const tree = parseSourceSafe(getTsParser('pattern.ts'), `(${text}) => {}`);
  if (tree.rootNode.hasError) unsupported('Cannot establish the Vue template binding pattern.');
  const arrow = tree.rootNode.firstNamedChild?.firstNamedChild;
  const parameters = arrow?.childForFieldName('parameters');
  if (!parameters) unsupported('Cannot establish the Vue template binding parameters.');
  const result: { name: string; start: number }[] = [];
  const visit = (node: Parser.SyntaxNode): void => {
    if (node.type === 'identifier' || node.type === 'shorthand_property_identifier_pattern') {
      result.push({ name: node.text, start: start + leading + node.startIndex - 1 });
      return;
    }
    if (
      ['assignment_pattern', 'object_assignment_pattern', 'computed_property_name'].includes(
        node.type,
      )
    )
      unsupported('Default or computed template bindings need additional expression evidence.');
    if (node.type === 'pair_pattern') {
      const value = node.childForFieldName('value');
      if (value) visit(value);
      return;
    }
    for (const child of node.namedChildren) visit(child);
  };
  visit(parameters!);
  return result;
}

/** Keep CSS literals opaque; only v-bind arguments execute in the component scope. */
function* cssBindingRanges(content: string, start: number, end: number) {
  for (let cursor = start; cursor < end; ) {
    if (content.startsWith('/*', cursor)) {
      const close = content.indexOf('*/', cursor + 2);
      if (close < 0 || close >= end) unsupported('Unclosed Vue CSS comment.');
      cursor = close + 2;
      continue;
    }
    const char = content[cursor];
    if (char === '"' || char === "'") {
      const quote = char;
      for (cursor++; cursor < end && content[cursor] !== quote; cursor++) {
        if (content[cursor] === '\\') cursor++;
      }
      if (cursor >= end) unsupported('Unclosed Vue CSS string.');
      cursor++;
      continue;
    }
    const binding =
      char === 'v' && !/[\w-]/.test(content[cursor - 1] ?? '')
        ? /^v-bind\s*\(/.exec(content.slice(cursor, end))
        : undefined;
    if (!binding) {
      cursor++;
      continue;
    }
    let expressionStart = cursor + binding[0].length;
    let depth = 0;
    let quote: string | undefined;
    for (cursor = expressionStart; cursor < end; cursor++) {
      const token = content[cursor];
      if (token === '\\') unsupported('Escaped Vue CSS bindings need a source mapping.');
      if (quote) {
        if (token === quote) quote = undefined;
      } else if (token === '"' || token === "'") {
        quote = token;
      } else if (token === '/' || token === '`') {
        unsupported('This Vue CSS expression needs quotes to establish its boundaries.');
      } else if (token === '(') {
        depth++;
      } else if (token === ')') {
        if (depth === 0) break;
        depth--;
      }
    }
    if (cursor >= end) unsupported('Unclosed Vue CSS binding.');
    let expressionEnd = cursor;
    while (/\s/.test(content[expressionStart] ?? '') && expressionStart < expressionEnd)
      expressionStart++;
    while (/\s/.test(content[expressionEnd - 1] ?? '') && expressionEnd > expressionStart)
      expressionEnd--;
    const first = content[expressionStart];
    if ((first === '"' || first === "'") && content[expressionEnd - 1] === first) {
      expressionStart++;
      expressionEnd--;
    }
    if (!content.slice(expressionStart, expressionEnd).trim())
      unsupported('Empty Vue CSS binding.');
    yield { start: expressionStart, end: expressionEnd };
    cursor++;
  }
}

/**
 * Retain original UTF-16 offsets and line breaks while parsing script, CSS, and template
 * expressions through the same TypeScript capture/resolution pipeline. Markup is
 * only an expression boundary; no written identifier is invented or substituted.
 */
function projectSfc(content: string): Projection {
  const text = content.replace(/[^\r\n]/g, ' ').split('');
  const templateRanges: { start: number; end: number; scope?: TemplateScope }[] = [];
  const scopes: TemplateScope[] = [];
  const componentTags: {
    start: number;
    end: number;
    name: string;
    kebab: boolean;
    scope?: TemplateScope;
  }[] = [];
  const shorthandAttributes: number[] = [];
  const stack: { name: string; scope?: TemplateScope; verbatim: boolean }[] = [];
  let templateDepth = 0;
  let setup = false;
  let jsx = false;
  const copy = (start: number, end: number) => {
    for (let i = start; i < end; i++) text[i] = content[i]!;
  };
  const expression = (start: number, end: number, scope?: TemplateScope, statements = false) => {
    if (/&(?:#\d+|#x[\da-f]+|\w+);/i.test(content.slice(start, end)))
      unsupported('HTML entities in Vue expressions need a source mapping.');
    // The two opening punctuation characters and closing quote/braces belong to
    // markup, and provide room for a standalone parenthesized expression.
    text[start - 2] = ';';
    text[start - 1] = statements ? '{' : '(';
    copy(start, end);
    text[end] = statements ? '}' : ')';
    if (text[end + 1] === ' ') text[end + 1] = ';';
    templateRanges.push({ start, end, scope });
  };
  for (let cursor = 0; cursor < content.length; ) {
    if (content.startsWith('<!--', cursor)) {
      const end = content.indexOf('-->', cursor + 4);
      if (end < 0) unsupported('Unclosed Vue comment.');
      cursor = end + 3;
      continue;
    }
    if (templateDepth && !stack.at(-1)?.verbatim && content.startsWith('{{', cursor)) {
      const end = content.indexOf('}}', cursor + 2);
      if (end < 0) unsupported('Unclosed Vue interpolation.');
      expression(cursor + 2, end, stack.at(-1)?.scope);
      cursor = end + 2;
      continue;
    }
    if (content[cursor] !== '<') {
      cursor++;
      continue;
    }
    const tag = tagAt(content, cursor);
    if (!tag) {
      cursor++;
      continue;
    }
    if (
      !tag.closing &&
      (['script', 'style'].includes(tag.name.toLowerCase()) ||
        (!templateDepth && tag.name !== 'template'))
    ) {
      if (tag.name.toLowerCase() === 'style') {
        if (tag.attributes.some((attribute) => attribute.name === 'src'))
          unsupported('External Vue styles need their own source binding.');
        if (
          tag.attributes.some((attribute) => attribute.name === 'lang' && attribute.value !== 'css')
        )
          unsupported('The Vue style language needs its own source mapping.');
      }
      if (tag.selfClosing) {
        cursor = tag.end;
        continue;
      }
      const escapedName = tag.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const close = new RegExp(`</${escapedName}\\s*>`, 'ig');
      close.lastIndex = tag.end;
      const end = close.exec(content);
      if (!end) unsupported('Unclosed Vue raw block.');
      if (tag.name.toLowerCase() === 'script') {
        if (tag.attributes.some((attribute) => attribute.name === 'src'))
          unsupported('External Vue scripts need their own source binding.');
        setup ||= tag.attributes.some((attribute) => attribute.name === 'setup');
        jsx ||= tag.attributes.some(
          (attribute) =>
            attribute.name === 'lang' && ['jsx', 'tsx'].includes(attribute.value ?? ''),
        );
        copy(tag.end, end!.index);
      } else if (tag.name.toLowerCase() === 'style') {
        const scope: TemplateScope = {
          start: tag.start,
          end: end!.index,
          bindings: [],
          deferred: true,
        };
        for (const binding of cssBindingRanges(content, tag.end, end!.index)) {
          if (!scopes.includes(scope)) scopes.push(scope);
          expression(binding.start, binding.end, scope);
        }
      }
      cursor = end!.index + end![0].length;
      continue;
    }
    let scope = stack.at(-1)?.scope;
    const verbatim =
      stack.at(-1)?.verbatim || tag.attributes.some((attribute) => attribute.name === 'v-pre');
    if (tag.name === 'template') templateDepth += tag.closing ? -1 : 1;
    if (tag.name === 'template' && tag.attributes.some((attribute) => attribute.name === 'src'))
      unsupported('External Vue templates need their own source binding.');
    if (
      tag.name === 'template' &&
      tag.attributes.some((attribute) => attribute.name === 'lang' && attribute.value !== 'html')
    )
      unsupported('The Vue template language needs its own source mapping.');
    if (templateDepth && !tag.closing && !verbatim) {
      const parent = scope;
      const localBindings: { name: string; start: number }[] = [];
      for (const attribute of tag.attributes) {
        const loop = attribute.name === 'v-for';
        const slot =
          attribute.name === 'v-slot' ||
          attribute.name.startsWith('v-slot:') ||
          attribute.name.startsWith('#');
        if (!loop && !slot) continue;
        if (attribute.start === undefined) continue;
        const match = loop ? /^(.*?)\s+(?:in|of)\s+([\s\S]+)$/.exec(attribute.value!) : undefined;
        if (loop && !match) unsupported('Cannot establish the Vue loop binding range.');
        const pattern = loop ? match![1]! : attribute.value!;
        localBindings.push(...templateBindings(pattern, attribute.start));
        if (loop) {
          const start = attribute.start + attribute.value!.length - match![2]!.length;
          expression(start, attribute.start + attribute.value!.length, parent);
        }
      }
      if (localBindings.length || (tag.name === 'template' && templateDepth === 1)) {
        scope = {
          start: tag.start,
          end: content.length,
          parent,
          bindings: localBindings,
          deferred: tag.name === 'template' && templateDepth === 1,
        };
        scopes.push(scope);
      }
      for (const attribute of tag.attributes) {
        const dynamic = /\[([^\]]+)\]/.exec(attribute.name);
        if (dynamic) {
          const start = attribute.nameStart + dynamic.index + 1;
          expression(start, start + dynamic[1]!.length, scope);
        }
        if (attribute.name === 'v-for' || /^(?:v-slot|#)/.test(attribute.name)) continue;
        if (attribute.start !== undefined && /^(?:[:@]|v-)/.test(attribute.name)) {
          const event = /^(?:@|v-on:)/.test(attribute.name);
          let expressionScope = attribute.name === 'v-if' ? parent : scope;
          if (event) {
            expressionScope = {
              start: attribute.nameStart,
              end: attribute.start + attribute.value!.length + 1,
              parent: scope,
              bindings: [{ name: '$event', start: attribute.nameStart, synthetic: true }],
            };
            scopes.push(expressionScope);
          }
          expression(
            attribute.start,
            attribute.start + attribute.value!.length,
            expressionScope,
            event,
          );
        }
        if (attribute.start === undefined && /^(?::|v-bind:)/.test(attribute.name)) {
          const name = attribute.name.replace(/^(?::|v-bind:)/, '');
          if (!/^[$_\p{ID_Start}][$_\p{ID_Continue}]*$/u.test(name))
            unsupported('The Vue shorthand attribute needs an explicit binding value.');
          const start = attribute.nameStart + attribute.name.length - name.length;
          expression(start, start + name.length, scope);
          shorthandAttributes.push(start);
        }
      }
    }
    if (templateDepth) {
      const pascal = /^[A-Z][\w$]*$/.test(tag.name);
      const namespaced = /^[A-Z][\w$]*(?:\.[$\w]+)+$/.test(tag.name);
      const kebab = /^[a-z][\w]*(?:-[\w]+)+$/.test(tag.name) && !BUILTIN_TAGS.has(tag.name);
      if (!verbatim && (pascal || kebab || namespaced)) {
        // PascalCase component tags are lexical reads of the setup import/binding.
        if (pascal || namespaced) {
          text[tag.nameStart - 1] = ';';
          copy(tag.nameStart, tag.nameStart + tag.name.length);
          text[tag.nameStart + tag.name.length] = ';';
        }
        templateRanges.push({ start: tag.nameStart, end: tag.nameStart + tag.name.length, scope });
        if (!namespaced)
          componentTags.push({
            start: tag.nameStart,
            end: tag.nameStart + tag.name.length,
            scope,
            kebab,
            name: kebab
              ? tag.name
                  .split('-')
                  .map((word) => word[0]!.toUpperCase() + word.slice(1))
                  .join('')
              : tag.name,
          });
      }
      if (!tag.closing && !tag.selfClosing && !VOID_TAGS.has(tag.name))
        stack.push({ name: tag.name, scope, verbatim });
      if (tag.selfClosing && scope !== stack.at(-1)?.scope && scope) scope.end = tag.end;
    }
    if (tag.closing && stack.at(-1)?.name === tag.name) {
      const entry = stack.pop()!;
      if (entry.scope && entry.scope !== stack.at(-1)?.scope) entry.scope.end = tag.end;
    }
    cursor = tag.end;
  }
  return {
    text: text.join(''),
    templateRanges,
    scopes,
    setup,
    jsx,
    componentTags,
    shorthandAttributes,
  };
}

function withTemplateScopes(source: RenameSource, projection: Projection): RenameSource {
  const range = (start: number, end: number): Range => {
    const before = source.content.slice(0, start).split('\n');
    const through = source.content.slice(0, end).split('\n');
    return {
      startLine: before.length,
      startCol: before.at(-1)!.length,
      endLine: through.length,
      endCol: through.at(-1)!.length,
    };
  };
  const offset = (line: number, col: number) => {
    let start = 0;
    for (let i = 1; i < line; i++) start = source.content.indexOf('\n', start) + 1;
    return start + col;
  };
  const id = (scope?: TemplateScope) =>
    scope ? `scope:${source.path}#vue-template:${scope.start}` : source.parsed.moduleScope;
  const scopeAt = (start: number) =>
    projection.templateRanges.find((entry) => entry.start - 1 <= start && entry.end > start)?.scope;
  const templateScopes: Scope[] = projection.scopes.map((scope) => ({
    id: id(scope),
    parent: id(scope.parent),
    kind: 'Block',
    range: range(scope.start, scope.end),
    filePath: source.path,
    bindings: new Map(),
    ownedDefs: [],
    imports: [],
    typeBindings: new Map(),
    lexicalNames: new Set(scope.bindings.map((binding) => binding.name)),
    nameClaims: scope.bindings.map((binding) => ({
      name: binding.name,
      kind: 'binding',
      range: binding.synthetic
        ? range(scope.start, scope.end)
        : range(binding.start, binding.start + binding.name.length),
    })),
    lookupPolicy: { nameClaimsComplete: true, deferParentActivation: scope.deferred },
  }));
  const references = new Map(
    source.parsed.referenceSites.map((site) => [
      site,
      site.inScope === source.parsed.moduleScope
        ? { ...site, inScope: id(scopeAt(offset(site.atRange.startLine, site.atRange.startCol))) }
        : site,
    ]),
  );
  const bindings: RenameOccurrence[] = projection.scopes.flatMap((scope) =>
    scope.bindings
      .filter((binding) => !binding.synthetic)
      .map((binding) => ({
        name: binding.name,
        role: 'binding',
        range: range(binding.start, binding.start + binding.name.length),
        spans: [{ start: binding.start, length: binding.name.length }],
      })),
  );
  const kebabTags: VueOccurrence[] = projection.componentTags
    .filter((tag) => tag.kebab)
    .map((tag) => {
      const nameRange = range(tag.start, tag.end);
      const referenceSite: ReferenceSite = {
        name: tag.name,
        nameRange,
        atRange: nameRange,
        kind: 'read',
        inScope: id(tag.scope),
      };
      return {
        name: tag.name,
        range: nameRange,
        spans: [{ start: tag.start, length: tag.end - tag.start }],
        role: 'name',
        referenceSite,
        templateTag: 'kebab',
      };
    });
  return {
    ...source,
    occurrences: [
      ...source.occurrences.map((occurrence) => ({
        ...occurrence,
        ...(occurrence.referenceSite
          ? { referenceSite: references.get(occurrence.referenceSite) }
          : {}),
        ...(projection.componentTags.some((tag) => tag.start === occurrence.spans[0]?.start)
          ? { templateTag: 'pascal' as const }
          : {}),
        ...(projection.shorthandAttributes.includes(occurrence.spans[0]!.start)
          ? { shorthandAttribute: true }
          : {}),
      })),
      ...bindings,
      ...kebabTags,
    ],
    parsed: {
      ...source.parsed,
      referenceSites: [...references.values(), ...kebabTags.map((tag) => tag.referenceSite!)],
      scopes: [
        ...source.parsed.scopes.map((scope) =>
          scope.id === source.parsed.moduleScope
            ? { ...scope, range: range(0, source.content.length) }
            : scope.parent === source.parsed.moduleScope
              ? {
                  ...scope,
                  parent: id(scopeAt(offset(scope.range.startLine, scope.range.startCol))),
                }
              : scope,
        ),
        ...templateScopes,
      ],
    },
  };
}

export const vueRenameProvider: RenameProvider = {
  ...typescriptRenameProvider,
  rewrite(context) {
    if ((context.occurrence as VueOccurrence).shorthandAttribute)
      return context.occurrence.spans.map((span) => ({
        ...span,
        oldText: context.source.content.slice(span.start, span.start + span.length),
        newText: `${context.source.content.slice(span.start, span.start + span.length)}="${context.newName}"`,
      }));
    const kind = (context.occurrence as VueOccurrence).templateTag;
    if (!kind) return typescriptRenameProvider.rewrite!(context);
    if (!/^[A-Z][\w$]*$/.test(context.newName))
      return { code: 'invalid_name', message: 'Vue component bindings require a PascalCase name.' };
    return context.occurrence.spans.map((span) => ({
      ...span,
      oldText: context.source.content.slice(span.start, span.start + span.length),
      newText:
        kind === 'kebab'
          ? context.newName.replace(/\B([A-Z])/g, '-$1').toLowerCase()
          : context.newName,
    }));
  },
  async parseSource(input) {
    const projection = projectSfc(input.content);
    if (!projection.setup && projection.templateRanges.length)
      unsupported('Options API template and CSS bindings need component-instance scope evidence.');
    const source = await typescriptRenameProvider.parseSource({
      ...input,
      tree: parseSourceSafe(
        getTsParser(projection.jsx ? 'embedded.tsx' : 'embedded.ts'),
        projection.text,
      ),
      languageProvider: {
        ...input.languageProvider,
        id: SupportedLanguages.TypeScript,
        preprocessSource: () => projection.text,
        emitScopeCaptures: (_content, path, tree) =>
          emitTsScopeCaptures(projection.text, path, tree, {
            scriptLanguage: projection.jsx ? 'tsx' : 'ts',
          }),
      },
    });
    return withTemplateScopes(source, projection);
  },
};
