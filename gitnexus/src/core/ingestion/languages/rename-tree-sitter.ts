import type Parser from 'tree-sitter';
import type { BindingRef, ParsedFile, Range, ReferenceSite } from 'gitnexus-shared';
import { createParserForLanguage } from '../../tree-sitter/parser-loader.js';
import { parseSourceSafe } from '../../tree-sitter/safe-parse.js';
import { extractParsedFile } from '../scope-extractor-bridge.js';
import type { RenameOccurrence, RenameProvider, RenameSource } from '../rename-provider.js';

/** Grammar policy is supplied by the language; this adapter only maps structure. */
export interface TreeSitterRenameOptions {
  readonly isName: (node: Parser.SyntaxNode) => boolean;
  readonly skip?: (node: Parser.SyntaxNode) => boolean;
  readonly role?: (node: Parser.SyntaxNode) => RenameOccurrence['role'];
  readonly canonicalName?: (name: string) => string;
  readonly transformParsed?: (parsed: ParsedFile) => ParsedFile;
  readonly reference?: (node: Parser.SyntaxNode, source: RenameSource) => ReferenceSite | undefined;
}

export function createTreeSitterRenameSource(
  options: TreeSitterRenameOptions,
): RenameProvider['parseSource'] {
  return async ({ filePath, content, languageProvider, scopeResolver, tree: providedTree }) => {
    const parseText = languageProvider.preprocessSource?.(content, filePath) ?? content;
    // Equal length alone is insufficient: moving line breaks moves semantic ranges.
    if (
      parseText.length !== content.length ||
      [...content.matchAll(/\r|\n/g)].some((match) => parseText[match.index!] !== match[0]) ||
      [...parseText.matchAll(/\r|\n/g)].some((match) => content[match.index!] !== match[0])
    ) {
      throw Object.assign(
        new Error(`Source preprocessing changes source coordinates: ${filePath}`),
        {
          code: 'unsupported_source',
          status: 'unsupported',
        },
      );
    }
    const tree =
      providedTree ??
      parseSourceSafe(await createParserForLanguage(languageProvider.id, filePath), parseText);
    if (!tree || tree.rootNode.hasError)
      throw Object.assign(new Error(`Cannot establish semantic coverage for ${filePath}.`), {
        code: 'parse_error',
      });
    let parsed = extractParsedFile(languageProvider, content, filePath, undefined, tree);
    if (!parsed)
      throw Object.assign(new Error(`Scope extraction is unavailable for ${filePath}.`), {
        code: 'incomplete_semantics',
      });
    // The resolution pass resets provider state before restoring pre-extracted
    // files, just as it does for worker output. Carry capture metadata with it.
    const captureSideChannel = languageProvider.collectCaptureSideChannel?.(filePath);
    if (captureSideChannel !== undefined) parsed = { ...parsed, captureSideChannel };
    scopeResolver.populateOwners(parsed);
    parsed = options.transformParsed?.(parsed) ?? parsed;
    const definitions = new Map(
      parsed.localDefs
        .filter((def) => def.nameRange)
        .map((def) => [rangeKey(def.nameRange!), def.nodeId]),
    );
    const references = new Map(
      parsed.referenceSites
        .filter((site) => site.nameRange)
        .map((site) => [rangeKey(site.nameRange!), site]),
    );
    const supplementalReferences: ReferenceSite[] = [];
    const occurrences: RenameOccurrence[] = [];
    const source: RenameSource = { path: filePath, content, tree, parsed, occurrences };
    for (const node of walkNamedNodes(tree.rootNode, options.skip)) {
      if (!options.isName(node)) continue;
      const range = nodeRange(node);
      const start = node.startIndex;
      const length = node.endIndex - start;
      // A preprocessor may mask tokens, but must not substitute a written name.
      if (content.slice(start, start + length) !== node.text)
        throw Object.assign(
          new Error(`A transformed identifier has no original spelling: ${filePath}`),
          {
            code: 'unsupported_source',
            status: 'unsupported',
          },
        );
      const role = options.role?.(node) ?? 'name';
      const definitionId = definitions.get(rangeKey(range));
      let referenceSite = references.get(rangeKey(range));
      if (!definitionId && !referenceSite && role === 'name') {
        referenceSite = options.reference?.(node, source);
        if (referenceSite) {
          references.set(rangeKey(range), referenceSite);
          supplementalReferences.push(referenceSite);
        }
      }
      occurrences.push({
        name: options.canonicalName?.(node.text) ?? node.text,
        range,
        spans: [{ start, length }],
        node,
        role,
        definitionId,
        referenceSite,
      });
    }
    return {
      ...source,
      parsed: { ...parsed, referenceSites: [...parsed.referenceSites, ...supplementalReferences] },
    };
  };
}

export function* walkNamedNodes(
  root: Parser.SyntaxNode,
  skip?: (node: Parser.SyntaxNode) => boolean,
): Generator<Parser.SyntaxNode> {
  const pending = [root];
  while (pending.length) {
    const node = pending.pop()!;
    if (skip?.(node)) continue;
    yield node;
    for (let i = node.namedChildCount - 1; i >= 0; i--) pending.push(node.namedChild(i)!);
  }
}

export function nodeRange(node: Parser.SyntaxNode): Range {
  return {
    startLine: node.startPosition.row + 1,
    startCol: node.startPosition.column,
    endLine: node.endPosition.row + 1,
    endCol: node.endPosition.column,
  };
}

export function rangeKey(range: Range): string {
  return `${range.startLine}:${range.startCol}:${range.endLine}:${range.endCol}`;
}

export function containsRange(container: Range, range: Range): boolean {
  return (
    (range.startLine > container.startLine ||
      (range.startLine === container.startLine && range.startCol >= container.startCol)) &&
    (range.endLine < container.endLine ||
      (range.endLine === container.endLine && range.endCol <= container.endCol))
  );
}

export function innermostRenameScope(
  parsed: ParsedFile,
  node: Parser.SyntaxNode,
): string | undefined {
  const range = nodeRange(node);
  let result: ParsedFile['scopes'][number] | undefined;
  for (const scope of parsed.scopes) {
    if (containsRange(scope.range, range) && (!result || containsRange(result.range, scope.range)))
      result = scope;
  }
  return result?.id;
}

/** Normalize lookup spellings while retaining source identities and coordinates. */
export function canonicalizeRenameBindings(
  parsed: ParsedFile,
  canonicalName: (name: string) => string,
): ParsedFile {
  const bindingsOf = (scope: ParsedFile['scopes'][number]) => {
    const bindings = new Map<string, BindingRef[]>();
    for (const [name, values] of scope.bindings) {
      const key = canonicalName(name);
      bindings.set(key, [...(bindings.get(key) ?? []), ...values]);
    }
    return bindings;
  };
  return {
    ...parsed,
    scopes: parsed.scopes.map((scope) => ({
      ...scope,
      bindings: bindingsOf(scope),
      lexicalNames: scope.lexicalNames && new Set([...scope.lexicalNames].map(canonicalName)),
      nameClaims: scope.nameClaims?.map((claim) => ({ ...claim, name: canonicalName(claim.name) })),
      typeBindings: new Map(
        [...scope.typeBindings].map(([name, type]) => [
          canonicalName(name),
          {
            ...type,
            rawName: canonicalName(type.rawName),
            ...(type.declaredSpelling
              ? { declaredSpelling: canonicalName(type.declaredSpelling) }
              : {}),
          },
        ]),
      ),
    })),
    parsedImports: parsed.parsedImports.map((entry) => ({
      ...entry,
      ...('localName' in entry ? { localName: canonicalName(entry.localName) } : {}),
      ...('importedName' in entry ? { importedName: canonicalName(entry.importedName) } : {}),
      ...('alias' in entry && entry.alias ? { alias: canonicalName(entry.alias) } : {}),
    })),
    referenceSites: parsed.referenceSites.map((site) => ({
      ...site,
      name: canonicalName(site.name),
      ...(site.explicitReceiver
        ? { explicitReceiver: { name: canonicalName(site.explicitReceiver.name) } }
        : {}),
    })),
  };
}
