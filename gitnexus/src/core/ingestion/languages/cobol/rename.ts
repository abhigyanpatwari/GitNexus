import type { RenameIssue, RenameProvider, RenameSource } from '../../rename-provider.js';
import { extractParsedFile } from '../../scope-extractor-bridge.js';
import {
  COBOL_RESERVED,
  cobolRangeKey,
  cobolTokenRange,
  readCobolSemanticSource,
  type CobolSemanticSource,
} from './semantic.js';

const unsupported = (message: string): RenameIssue => ({
  code: 'unsupported_occurrence',
  message,
  status: 'unsupported',
});
const evidence = new WeakMap<RenameSource, CobolSemanticSource>();
const factsFor = (source: RenameSource) => evidence.get(source)!;

export const cobolRenameProvider: RenameProvider = {
  canonicalName: (name, context) =>
    (context?.definition?.type === 'Namespace'
      ? name.slice(name.lastIndexOf(':') + 1)
      : name
    ).toUpperCase(),
  validateName(name) {
    if (
      !/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(name) ||
      !/[A-Za-z]/.test(name) ||
      name.length > 31 ||
      COBOL_RESERVED.has(name.toUpperCase())
    )
      return {
        code: 'invalid_name',
        message:
          'Use a COBOL identifier of at most 31 letters, digits or hyphens, containing a letter and no reserved word.',
      };
  },
  matchesGraphIdentity({ definition, node }) {
    return (
      definition.type === node.label &&
      definition.nameRange !== undefined &&
      definition.declarationRange?.startLine === node.properties.startLine! + 1 &&
      definition.declarationRange?.endLine === node.properties.endLine! + 1
    );
  },
  parseSource({ filePath, content, languageProvider }) {
    const facts = readCobolSemanticSource(content, filePath);
    if (facts.tokens.some((token) => token.kind === 'invalid'))
      throw unsupported(
        'COBOL debug lines or split-token continuations require source expansion before rename.',
      );
    const parsed = extractParsedFile(languageProvider, content, filePath);
    if (!parsed)
      throw {
        code: 'incomplete_semantics',
        message: `Could not extract COBOL bindings in ${filePath}.`,
      };
    const definitions = new Map(
      parsed.localDefs
        .filter((def) => def.nameRange)
        .map((def) => [cobolRangeKey(def.nameRange!), def]),
    );
    const references = new Map(
      parsed.referenceSites
        .filter((site) => site.nameRange)
        .map((site) => [cobolRangeKey(site.nameRange!), site]),
    );
    const offsets = [0];
    for (let index = 0; index < content.length; index++)
      if (content[index] === '\n') offsets.push(index + 1);
    const tokens = new Map(
      facts.tokens
        .filter((token) => token.kind === 'word')
        .map((token) => [cobolRangeKey(cobolTokenRange(token)), token]),
    );
    for (const ref of facts.references)
      tokens.set(cobolRangeKey(cobolTokenRange(ref.token)), ref.token);
    const unclassified = new Set(facts.unclassified);
    const source: RenameSource = {
      path: filePath,
      content,
      parsed,
      occurrences: [...tokens.values()].map((token) => {
        const range = cobolTokenRange(token);
        const key = cobolRangeKey(range);
        const definition = definitions.get(key);
        const referenceSite = references.get(key);
        return {
          name: token.upper,
          range,
          spans: [{ start: offsets[token.line - 1]! + token.column, length: token.text.length }],
          ...(definition ? { definitionId: definition.nodeId } : {}),
          ...(referenceSite ? { referenceSite } : {}),
          role:
            definition || referenceSite || unclassified.has(token)
              ? ('name' as const)
              : ('unrelated' as const),
        };
      }),
    };
    evidence.set(source, facts);
    return source;
  },
  checkSafety(context) {
    const source = context.files.get(context.target.filePath)!;
    const facts = factsFor(source);
    const target = facts.declarations.find(
      (d) => cobolRangeKey(cobolTokenRange(d.token)) === cobolRangeKey(context.target.nameRange!),
    );
    if (!target) return unsupported('The COBOL declaration has no original source identity.');
    for (const file of context.files.values()) {
      const unknown = factsFor(file).unclassified.find(
        (token) =>
          token.upper === target.token.upper || token.upper === context.newName.toUpperCase(),
      );
      if (unknown)
        return unsupported(
          `An unclassified COBOL clause operand in ${file.path}:${unknown.line} prevents proving rename coverage.`,
        );
    }
    if (context.target.type === 'Module') {
      for (const file of context.files.values()) {
        const candidate = factsFor(file);
        if (candidate.dynamicCalls)
          return unsupported(
            'A dynamic CALL or CANCEL prevents proving all uses of this program name.',
          );
        if (
          candidate.declarations.some(
            (d) =>
              d.type === 'Module' &&
              d.token.upper === context.newName.toUpperCase() &&
              !(
                file.path === source.path &&
                cobolRangeKey(cobolTokenRange(d.token)) === cobolRangeKey(context.target.nameRange!)
              ),
          )
        )
          return {
            code: 'name_collision',
            message: 'The replacement already names a program in this COBOL workspace.',
          };
        if (
          candidate.extracted.execCicsBlocks.some(
            (block) =>
              block.programName?.toUpperCase() === target.token.upper ||
              (block.programName && !block.programIsLiteral),
          )
        )
          return unsupported(
            'An embedded CICS program lookup prevents complete static program rename coverage.',
          );
      }
    }
    const sameOwner = facts.declarations.filter(
      (d) =>
        d !== target &&
        d.program === target.program &&
        d.type === target.type &&
        d.parents.length === target.parents.length &&
        d.parents.every((parent, index) => parent === target.parents[index]),
    );
    if (sameOwner.some((d) => d.token.upper === context.newName.toUpperCase()))
      return {
        code: 'name_collision',
        message: 'The replacement already names a declaration in this COBOL owner.',
      };
  },
  checkOccurrence({ selected, source, occurrence }) {
    if (!selected) return;
    const tokens = factsFor(source).tokens;
    let embedded = false;
    for (const token of tokens) {
      if (
        token.line > occurrence.range.startLine ||
        (token.line === occurrence.range.startLine && token.column > occurrence.range.startCol)
      )
        break;
      if (token.upper === 'EXEC') embedded = true;
      if (token.upper === 'END-EXEC') embedded = false;
    }
    if (embedded)
      return unsupported(
        'An embedded EXEC operand requires its own language binding proof before rename.',
      );
  },
  validateRewrite({ source, updated, edits }) {
    const free = />>SOURCE\s+(?:FORMAT\s+(?:IS\s+)?)?FREE/i.test(
      source.content.split('\n', 10).join('\n'),
    );
    if (free) return;
    const oldLines = source.content.split(/\r?\n/);
    const newLines = updated.content.split(/\r?\n/);
    let offset = 0;
    for (let line = 0; line < oldLines.length; line++) {
      const original = oldLines[line]!;
      const touched = edits.some(
        (edit) => edit.start >= offset && edit.start < offset + original.length,
      );
      if (
        touched &&
        (original.slice(72) !== newLines[line]!.slice(72) ||
          (!original.slice(72).trim() && newLines[line]!.slice(72).trim()))
      )
        return unsupported(
          'The replacement would move fixed-format code or identification columns past column 72.',
        );
      offset += original.length + (source.content[offset + original.length] === '\r' ? 2 : 1);
    }
  },
};
