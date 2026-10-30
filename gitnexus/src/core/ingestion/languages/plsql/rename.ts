/**
 * Rename for PL/SQL packages and subprograms.
 *
 * Every identifier-like token of a file becomes an occurrence:
 *   - declaration names (body, spec declaration) carry their definition id;
 *   - call parts, package qualifiers and `END <label>`s carry the reference
 *     site whose binding the scope resolver records;
 *   - expression identifiers that are not recorded call sites (variables,
 *     columns — or argument-less function calls the grammar cannot tell apart)
 *     are left unproven, so a same-named one makes the engine refuse;
 *   - everything else is `unrelated`.
 *
 * A spec declaration and its body (and a package spec and its body) form one
 * symbol family and are renamed together. Rename is refused when the name
 * appears in dynamic SQL text or in a segment the grammar could not parse.
 */

import { CharStream, CommonTokenStream, Token } from 'antlr4ng';
import type { Range, SymbolDefinition } from 'gitnexus-shared';
import type {
  RenameIssue,
  RenameOccurrence,
  RenameProvider,
  RenameSource,
} from '../../rename-provider.js';
import { extractParsedFile } from '../../scope-extractor-bridge.js';
import { PlSqlLexer } from '../../plsql/generated/PlSqlLexer.js';
import { preprocessPlSql } from '../../plsql/preprocess.js';
import {
  normaliseIdentifier,
  type PlSqlDefinition,
  type PlSqlFileFacts,
} from '../../plsql/extract.js';
import { PlSqlPackageInstances, plsqlSignatureKey } from '../../plsql/resolve.js';
import { plsqlFactsFor, plsqlNameRange, plsqlRangeKey, plsqlTokenRange } from './captures.js';

const unsupported = (message: string): RenameIssue => ({
  code: 'unsupported_occurrence',
  message,
  status: 'unsupported',
});

const evidence = new WeakMap<RenameSource, PlSqlFileFacts>();

/** Reserved words that can never name a PL/SQL object (V$RESERVED_WORDS, reserved = 'Y'). */
const PLSQL_RESERVED = new Set(
  'ACCESS ADD ALL ALTER AND ANY AS ASC AUDIT BEGIN BETWEEN BY CASE CHAR CHECK CLUSTER COLUMN COMMENT COMPRESS CONNECT CREATE CURRENT DATE DECIMAL DECLARE DEFAULT DELETE DESC DISTINCT DROP ELSE ELSIF END EXCEPTION EXCLUSIVE EXISTS FILE FLOAT FOR FROM FUNCTION GRANT GROUP HAVING IDENTIFIED IF IMMEDIATE IN INCREMENT INDEX INITIAL INSERT INTEGER INTERSECT INTO IS LEVEL LIKE LOCK LONG LOOP MAXEXTENTS MINUS MLSLABEL MODE MODIFY NOAUDIT NOCOMPRESS NOT NOWAIT NULL NUMBER OF OFFLINE ON ONLINE OPTION OR ORDER PACKAGE PCTFREE PRIOR PROCEDURE PUBLIC RAISE RAW RENAME RESOURCE RETURN REVOKE ROW ROWID ROWNUM ROWS SELECT SESSION SET SHARE SIZE SMALLINT START SUCCESSFUL SYNONYM SYSDATE TABLE THEN TO TRIGGER UID UNION UNIQUE UPDATE USER VALIDATE VALUES VARCHAR VARCHAR2 VIEW WHENEVER WHEN WHERE WHILE WITH'.split(
    ' ',
  ),
);

const IDENTIFIER_TOKEN = /^(?:[A-Za-z][\w$#]*|"[^"]+")$/;

function definitionFor(
  source: RenameSource,
  symbol: SymbolDefinition,
): PlSqlDefinition | undefined {
  const facts = evidence.get(source);
  if (!facts || !symbol.nameRange) return undefined;
  const key = plsqlRangeKey(symbol.nameRange);
  return facts.definitions.find((d) => plsqlRangeKey(plsqlNameRange(d)) === key);
}

export const plsqlRenameProvider: RenameProvider = {
  canonicalName: (name) => normaliseIdentifier(name),

  validateName(name) {
    if (!/^[A-Za-z][A-Za-z0-9_$#]{0,127}$/.test(name) || PLSQL_RESERVED.has(name.toUpperCase())) {
      return {
        code: 'invalid_name',
        message:
          'Use an unquoted PL/SQL identifier: a letter followed by letters, digits, _, $ or #, at most 128 characters, and no reserved word.',
      };
    }
  },

  matchesGraphIdentity({ definition, node }) {
    return (
      definition.type === node.label &&
      definition.declarationRange !== undefined &&
      definition.declarationRange.startLine === node.properties.startLine! + 1
    );
  },

  parseSource({ filePath, content, languageProvider }) {
    const facts = plsqlFactsFor(content, filePath);
    const parsed = extractParsedFile(languageProvider, content, filePath);
    if (!parsed)
      throw {
        code: 'incomplete_semantics',
        message: `Could not extract PL/SQL bindings in ${filePath}.`,
      };

    const definitions = new Map(
      parsed.localDefs.filter((d) => d.nameRange).map((d) => [plsqlRangeKey(d.nameRange!), d]),
    );
    const references = new Map(
      parsed.referenceSites.filter((s) => s.nameRange).map((s) => [plsqlRangeKey(s.nameRange!), s]),
    );
    const unproven = new Set(facts.expressionNames.map((t) => plsqlRangeKey(plsqlTokenRange(t))));

    const lineStarts = [0];
    for (let i = 0; i < content.length; i++) if (content[i] === '\n') lineStarts.push(i + 1);

    // Pre-processing keeps every line and column of the remaining text, so
    // token positions map straight back onto the original content.
    const lexer = new PlSqlLexer(CharStream.fromString(preprocessPlSql(content)));
    lexer.removeErrorListeners();
    const stream = new CommonTokenStream(lexer);
    stream.fill();
    const occurrences = new Map<string, RenameOccurrence>();
    for (const token of stream.getTokens()) {
      if (token.channel !== Token.DEFAULT_CHANNEL || token.type === Token.EOF) continue;
      const text = token.text ?? '';
      if (!IDENTIFIER_TOKEN.test(text)) continue;
      const range: Range = {
        startLine: token.line,
        startCol: token.column,
        endLine: token.line,
        endCol: token.column + text.length,
      };
      const key = plsqlRangeKey(range);
      const definition = definitions.get(key);
      const referenceSite = references.get(key);
      occurrences.set(key, {
        name: normaliseIdentifier(text),
        range,
        spans: [{ start: lineStarts[token.line - 1]! + token.column, length: text.length }],
        ...(definition ? { definitionId: definition.nodeId } : {}),
        ...(referenceSite ? { referenceSite } : {}),
        role: definition || referenceSite || unproven.has(key) ? 'name' : 'unrelated',
      });
    }
    const source: RenameSource = {
      path: filePath,
      content,
      parsed,
      occurrences: [...occurrences.values()],
    };
    evidence.set(source, facts);
    return source;
  },

  symbolFamily(context) {
    const targetSource = context.files.get(context.target.filePath);
    const target = targetSource && definitionFor(targetSource, context.target);
    if (!target) return unsupported('The PL/SQL declaration has no source identity.');
    // One family per package instance: a spec, its paired body and the
    // declarations inside them. Same-named copies elsewhere are other objects.
    const packages: Array<{ name: string; filePath: string; isSpec: boolean }> = [];
    for (const file of context.files.values()) {
      for (const d of evidence.get(file)?.definitions ?? []) {
        if (d.kind === 'package')
          packages.push({ name: d.name, filePath: file.path, isSpec: d.isSpec });
      }
    }
    const instances = new PlSqlPackageInstances(packages);
    const definesPackage = new Set(packages.map((p) => `${p.name}\0${p.filePath}`));
    const scopeOf = (d: PlSqlDefinition, filePath: string): string => {
      const pkg = d.kind === 'package' ? d.name : d.ownerPath[0];
      return pkg !== undefined && definesPackage.has(`${pkg}\0${filePath}`)
        ? `${pkg}\0${instances.homeOf(pkg, filePath) ?? filePath}`
        : `\0${filePath}`;
    };
    const targetScope = scopeOf(target, context.target.filePath);
    const sameEntity = (d: PlSqlDefinition, filePath: string) =>
      scopeOf(d, filePath) === targetScope &&
      (target.kind === 'package'
        ? d.kind === 'package' && d.name === target.name
        : d.kind === target.kind && plsqlSignatureKey(d) === plsqlSignatureKey(target));
    return context.definitions.filter((symbol) => {
      const source = context.files.get(symbol.filePath);
      const def = source && definitionFor(source, symbol);
      return def !== undefined && sameEntity(def, symbol.filePath);
    });
  },

  checkSafety(context) {
    const source = context.files.get(context.target.filePath);
    const target = source && definitionFor(source, context.target);
    if (!target) return unsupported('The PL/SQL declaration has no source identity.');
    if (target.fromFallback)
      return unsupported(
        'The declaration was recovered without a full parse; rename cannot prove its references.',
      );
    const word = new RegExp(`(^|[^\\w$#])${target.name.replace(/[$#]/g, '\\$&')}($|[^\\w$#])`, 'i');
    for (const file of context.files.values()) {
      const facts = evidence.get(file);
      if (!facts) continue;
      const dynamic = facts.dynamicSql.find((d) =>
        d.literal === undefined ? false : word.test(d.literal),
      );
      if (dynamic)
        return unsupported(
          `${target.name} appears in dynamic SQL at ${file.path}:${dynamic.line}; rename cannot rewrite it safely.`,
        );
      if (facts.segmentsWithErrors > 0 && word.test(file.content)) {
        return unsupported(
          `${file.path} has PL/SQL the grammar could not fully parse and mentions ${target.name}.`,
        );
      }
    }
  },
};
