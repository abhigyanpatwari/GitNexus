/**
 * PL/SQL fact extraction: walks the ANTLR parse tree of every segment and
 * returns parser-independent facts (definitions, call sites, table accesses,
 * dynamic SQL sites). Segments the grammar could not fully parse additionally
 * get regex-level definitions, marked `fromFallback`, for any subprogram the
 * error-recovered tree lost.
 *
 * Names are normalised the Oracle way: unquoted identifiers upper-case,
 * quoted identifiers verbatim without quotes.
 */

import {
  CharStream,
  CommonTokenStream,
  ParseTreeWalker,
  ParserRuleContext,
  Token,
  type ParseTree,
  type ParseTreeListener,
} from 'antlr4ng';
import { PlSqlParser as P } from './generated/PlSqlParser.js';
import { PlSqlLexer } from './generated/PlSqlLexer.js';
import { parsePlSqlSource, type PlSqlSegment } from './parse.js';
import { normaliseIdentifier } from './names.js';
import type { ScriptInclude, SqlPlusCommand } from './preprocess.js';

export type PlSqlDefKind = 'package' | 'procedure' | 'function' | 'trigger';
export type PlSqlAccessKind =
  | 'select'
  | 'insert'
  | 'update'
  | 'delete'
  | 'merge'
  | 'lock'
  | 'trigger';

/** One written identifier: normalised name plus its exact source position. */
export interface PlSqlNameToken {
  readonly name: string;
  readonly line: number;
  /** 0-based column. */
  readonly column: number;
  readonly length: number;
}

export interface PlSqlParameter {
  readonly name: string;
  readonly hasDefault: boolean;
  /** Normalised type text (`NUMBER`, `T_LOAN.ID%TYPE`); empty when omitted. */
  readonly type: string;
}

export interface PlSqlDefinition {
  readonly kind: PlSqlDefKind;
  readonly name: string;
  /** Schema prefix written on a top-level CREATE (`CREATE PACKAGE loan.pkg`). */
  readonly schema?: string;
  /** Enclosing definition names, outermost first (package, then subprograms). */
  readonly ownerPath: readonly string[];
  /** Index into `definitions` of the enclosing definition (by position); absent at top level and for fallback definitions. */
  readonly ownerIndex?: number;
  readonly startLine: number;
  /** 0-based column of the first token of the definition. */
  readonly startColumn: number;
  readonly endLine: number;
  /** 0-based column just past the last token of the definition. */
  readonly endColumn: number;
  readonly nameLine: number;
  readonly nameColumn: number;
  readonly nameLength: number;
  /** `END <name>` closing labels, which must be renamed with the definition. */
  readonly endLabels: readonly PlSqlNameToken[];
  readonly parameters: readonly PlSqlParameter[];
  /**
   * Package spec, or a subprogram declared in a package spec — i.e. public.
   * Forward declarations inside a package body are NOT spec declarations.
   */
  readonly isSpec: boolean;
  /**
   * Declaration without a body at this position: a package-spec declaration
   * or a forward declaration in a package body. Never owns call sites.
   */
  readonly declarationOnly: boolean;
  /** Trigger only: the table the trigger fires on. */
  readonly triggerTable?: string;
  /** True when the definition was recovered by the regex fallback. */
  readonly fromFallback: boolean;
}

export interface PlSqlCallSite {
  readonly ownerPath: readonly string[];
  /** Index into `definitions` of the innermost enclosing definition (by position). */
  readonly ownerIndex?: number;
  readonly line: number;
  readonly column: number;
  /** Dotted name parts (`PKG_LOG`, `WARN`); optional schema first. */
  readonly nameParts: readonly string[];
  /** Source position of every name part, aligned with `nameParts`. */
  readonly nameTokens: readonly PlSqlNameToken[];
  readonly arity?: number;
  readonly namedArguments: readonly string[];
  /** `statement` = procedure call statement, `expression` = function call in an expression. */
  readonly form: 'statement' | 'expression';
  readonly dbLink?: string;
}

export interface PlSqlTableAccess {
  readonly ownerPath: readonly string[];
  /** Index into `definitions` of the innermost enclosing definition (by position). */
  readonly ownerIndex?: number;
  readonly line: number;
  readonly column: number;
  readonly table: string;
  readonly schema?: string;
  readonly dbLink?: string;
  readonly kind: PlSqlAccessKind;
}

export interface PlSqlDynamicSqlSite {
  readonly ownerPath: readonly string[];
  /** Index into `definitions` of the innermost enclosing definition (by position). */
  readonly ownerIndex?: number;
  readonly line: number;
  /** Literal statement text when the argument is a string literal. */
  readonly literal?: string;
}

export interface PlSqlFileFacts {
  readonly scriptIncludes: readonly ScriptInclude[];
  /**
   * SQL*Plus client commands removed before parsing. `EXEC pkg.proc(…)` lines
   * name subprograms the parse tree never sees, so rename must consult them.
   */
  readonly sqlplusCommands: readonly SqlPlusCommand[];
  /**
   * Identifiers in expression positions that are not recorded call sites:
   * variables, columns, record fields — or argument-less function calls the
   * grammar cannot tell apart from them. Rename treats a same-named one as
   * unproven and refuses rather than guessing.
   */
  readonly expressionNames: readonly PlSqlNameToken[];
  readonly definitions: readonly PlSqlDefinition[];
  readonly calls: readonly PlSqlCallSite[];
  readonly accesses: readonly PlSqlTableAccess[];
  readonly dynamicSql: readonly PlSqlDynamicSqlSite[];
  readonly segments: number;
  readonly segmentsWithErrors: number;
  readonly segmentsTimedOut: number;
  readonly firstError?: string;
}

// ─── helpers ──────────────────────────────────────────────────────────────

export { normaliseIdentifier };

function splitDotted(text: string): string[] {
  // `"a.b".c` keeps the quoted part intact.
  const parts: string[] = [];
  let current = '';
  let quoted = false;
  for (const ch of text) {
    if (ch === '"') quoted = !quoted;
    if (ch === '.' && !quoted) {
      parts.push(normaliseIdentifier(current));
      current = '';
    } else current += ch;
  }
  if (current !== '') parts.push(normaliseIdentifier(current));
  return parts;
}

function childRule(ctx: ParserRuleContext, rule: number): ParserRuleContext | undefined {
  for (const c of ctx.children)
    if (c instanceof ParserRuleContext && c.ruleIndex === rule) return c;
  return undefined;
}

function childRules(ctx: ParserRuleContext, rule: number): ParserRuleContext[] {
  return ctx.children.filter(
    (c): c is ParserRuleContext => c instanceof ParserRuleContext && c.ruleIndex === rule,
  );
}

function textOf(tree: ParseTree | undefined): string {
  return tree ? tree.getText() : '';
}

function nameTokenOf(ctx: ParserRuleContext): PlSqlNameToken {
  return {
    name: normaliseIdentifier(ctx.getText()),
    line: ctx.start!.line,
    column: ctx.start!.column,
    length: (ctx.stop?.stop ?? ctx.start!.stop) - ctx.start!.start + 1,
  };
}

/** The last written identifier of a (possibly dotted) name rule. */
function lastNameCtx(ctx: ParserRuleContext): ParserRuleContext {
  const parts = ctx.children.filter(
    (c): c is ParserRuleContext =>
      c instanceof ParserRuleContext &&
      (c.ruleIndex === P.RULE_identifier || c.ruleIndex === P.RULE_id_expression),
  );
  return parts[parts.length - 1] ?? ctx;
}

/** Every written identifier of a dotted name rule, in order. */
function nameCtxs(ctx: ParserRuleContext): ParserRuleContext[] {
  const parts = ctx.children.filter(
    (c): c is ParserRuleContext =>
      c instanceof ParserRuleContext &&
      (c.ruleIndex === P.RULE_identifier || c.ruleIndex === P.RULE_id_expression),
  );
  return parts.length > 0 ? parts : [ctx];
}

/** `END <label>` of a subprogram/trigger body or package. */
function endLabelsOf(ctx: ParserRuleContext): PlSqlNameToken[] {
  if (ctx.ruleIndex === P.RULE_create_package || ctx.ruleIndex === P.RULE_create_package_body) {
    const names = childRules(ctx, P.RULE_package_name);
    return names.length > 1 ? [nameTokenOf(lastNameCtx(names[names.length - 1]!))] : [];
  }
  const findBody = (n: ParserRuleContext, depth: number): ParserRuleContext | undefined => {
    for (const c of n.children) {
      if (!(c instanceof ParserRuleContext)) continue;
      if (c.ruleIndex === P.RULE_body) return c;
      if (
        depth > 0 &&
        (c.ruleIndex === P.RULE_trigger_body || c.ruleIndex === P.RULE_trigger_block)
      ) {
        const nested = findBody(c, depth - 1);
        if (nested) return nested;
      }
      if (c.ruleIndex === P.RULE_compound_trigger_block) {
        const label = childRule(c, P.RULE_trigger_name);
        return label ? c : undefined;
      }
    }
    return undefined;
  };
  const body = findBody(ctx, 2);
  if (!body) return [];
  const label =
    body.ruleIndex === P.RULE_compound_trigger_block
      ? childRule(body, P.RULE_trigger_name)
      : childRule(body, P.RULE_label_name);
  return label ? [nameTokenOf(lastNameCtx(label))] : [];
}

function parametersOf(ctx: ParserRuleContext): PlSqlParameter[] {
  return childRules(ctx, P.RULE_parameter).map((p) => ({
    name: normaliseIdentifier(textOf(childRule(p, P.RULE_parameter_name))),
    hasDefault: childRule(p, P.RULE_default_value_part) !== undefined,
    type: textOf(childRule(p, P.RULE_type_spec)).toUpperCase(),
  }));
}

function argumentsOf(fnArg: ParserRuleContext | undefined): { arity?: number; named: string[] } {
  if (!fnArg) return { named: [] };
  const args = childRules(fnArg, P.RULE_argument);
  const named = args.flatMap((a) => {
    const id = childRule(a, P.RULE_identifier);
    return id ? [normaliseIdentifier(id.getText())] : [];
  });
  return { arity: args.length, named };
}

/** Decide read vs write for a `tableview_name`, from its nearest deciding ancestor. */
function accessKindOf(ctx: ParserRuleContext): PlSqlAccessKind | undefined {
  let prev: ParserRuleContext = ctx;
  for (let a = ctx.parent; a; prev = a, a = a.parent) {
    switch (a.ruleIndex) {
      case P.RULE_query_block:
      case P.RULE_subquery:
        return 'select';
      case P.RULE_insert_into_clause:
        return 'insert';
      case P.RULE_update_statement:
        return 'update';
      case P.RULE_delete_statement:
        return 'delete';
      case P.RULE_merge_statement:
        return childRule(a, P.RULE_selected_tableview) === prev ? 'merge' : 'select';
      case P.RULE_lock_table_statement:
        return 'lock';
      case P.RULE_create_trigger:
        return 'trigger';
      // DDL and type references are not data accesses.
      case P.RULE_create_table:
      case P.RULE_create_view:
      case P.RULE_type_spec:
      case P.RULE_parameter:
        return undefined;
    }
  }
  return undefined;
}

/** Common-table-expression names visible at a statement (filtered from accesses). */
function cteNamesAbove(ctx: ParserRuleContext): Set<string> {
  const names = new Set<string>();
  for (let a = ctx.parent; a; a = a.parent) {
    const withClause =
      a.ruleIndex === P.RULE_select_statement || a.ruleIndex === P.RULE_subquery
        ? childRule(a, P.RULE_with_clause)
        : undefined;
    if (!withClause) continue;
    const visit = (n: ParserRuleContext) => {
      if (n.ruleIndex === P.RULE_query_name) names.add(normaliseIdentifier(n.getText()));
      for (const c of n.children) if (c instanceof ParserRuleContext) visit(c);
    };
    visit(withClause);
  }
  return names;
}

const PSEUDO_TABLES = new Set(['DUAL']);

/** True for a subprogram spec inside `CREATE PACKAGE` (public), false for a body forward declaration. */
function insidePackageSpec(ctx: ParserRuleContext): boolean {
  for (let a = ctx.parent; a; a = a.parent) {
    if (a.ruleIndex === P.RULE_create_package) return true;
    if (a.ruleIndex === P.RULE_create_package_body) return false;
  }
  return false;
}

// ─── tree walk ────────────────────────────────────────────────────────────

const SCOPE_RULES = new Set([
  P.RULE_create_package,
  P.RULE_create_package_body,
  P.RULE_procedure_body,
  P.RULE_function_body,
  P.RULE_create_procedure_body,
  P.RULE_create_function_body,
  P.RULE_create_trigger,
]);

function extractSegment(
  segment: PlSqlSegment,
  out: {
    definitions: PlSqlDefinition[];
    calls: PlSqlCallSite[];
    accesses: PlSqlTableAccess[];
    dynamicSql: PlSqlDynamicSqlSite[];
    expressionNames: PlSqlNameToken[];
  },
): void {
  if (!segment.tree) return;
  const scope: string[] = [];
  /** Definition indices parallel to `scope`: sites record the innermost owner by position. */
  const owners: number[] = [];
  const ownerIndex = () => owners[owners.length - 1];

  const define = (
    ctx: ParserRuleContext,
    kind: PlSqlDefKind,
    nameCtx: ParserRuleContext | undefined,
    extra: {
      schema?: string;
      isSpec?: boolean;
      declarationOnly?: boolean;
      triggerTable?: string;
      push?: boolean;
    } = {},
  ) => {
    const parts = splitDotted(textOf(nameCtx));
    const name = parts[parts.length - 1] ?? '?';
    const schema = extra.schema ?? (parts.length > 1 ? parts[parts.length - 2] : undefined);
    const token = nameTokenOf(nameCtx ? lastNameCtx(nameCtx) : ctx);
    const stop = ctx.stop ?? ctx.start!;
    out.definitions.push({
      kind,
      name,
      schema,
      ownerPath: [...scope],
      ownerIndex: ownerIndex(),
      startLine: ctx.start!.line,
      startColumn: ctx.start!.column,
      endLine: stop.line,
      endColumn: stop.column + (stop.stop - stop.start + 1),
      nameLine: token.line,
      nameColumn: token.column,
      nameLength: token.length,
      endLabels: endLabelsOf(ctx),
      parameters: parametersOf(ctx),
      isSpec: extra.isSpec ?? false,
      declarationOnly: extra.declarationOnly ?? false,
      triggerTable: extra.triggerTable,
      fromFallback: false,
    });
    if (extra.push !== false) {
      scope.push(name);
      owners.push(out.definitions.length - 1);
    }
  };

  const listener: ParseTreeListener = {
    visitTerminal() {},
    visitErrorNode() {},
    enterEveryRule(ctx: ParserRuleContext) {
      switch (ctx.ruleIndex) {
        case P.RULE_create_package:
        case P.RULE_create_package_body: {
          const schemaCtx = childRule(ctx, P.RULE_schema_object_name);
          define(ctx, 'package', childRule(ctx, P.RULE_package_name), {
            schema: schemaCtx ? normaliseIdentifier(schemaCtx.getText()) : undefined,
            isSpec: ctx.ruleIndex === P.RULE_create_package,
          });
          break;
        }
        case P.RULE_procedure_spec:
        case P.RULE_function_spec:
          define(
            ctx,
            ctx.ruleIndex === P.RULE_procedure_spec ? 'procedure' : 'function',
            childRule(ctx, P.RULE_identifier),
            { isSpec: insidePackageSpec(ctx), declarationOnly: true, push: false },
          );
          break;
        case P.RULE_procedure_body:
          define(ctx, 'procedure', childRule(ctx, P.RULE_identifier));
          break;
        case P.RULE_function_body:
          define(ctx, 'function', childRule(ctx, P.RULE_identifier));
          break;
        case P.RULE_create_procedure_body:
          define(ctx, 'procedure', childRule(ctx, P.RULE_procedure_name));
          break;
        case P.RULE_create_function_body:
          define(ctx, 'function', childRule(ctx, P.RULE_function_name));
          break;
        case P.RULE_create_trigger: {
          let triggerTable: string | undefined;
          const findTable = (n: ParserRuleContext): boolean => {
            if (n.ruleIndex === P.RULE_tableview_name) {
              const parts = splitDotted(n.getText());
              triggerTable = parts[parts.length - 1];
              return true;
            }
            return n.children.some(
              (c) =>
                c instanceof ParserRuleContext &&
                c.ruleIndex !== P.RULE_trigger_body &&
                findTable(c),
            );
          };
          findTable(ctx);
          define(ctx, 'trigger', childRule(ctx, P.RULE_trigger_name), { triggerTable });
          break;
        }
        case P.RULE_call_statement: {
          const routines = childRules(ctx, P.RULE_routine_name);
          const fnArgs = childRules(ctx, P.RULE_function_argument);
          // `a.b(x).c(y)` chains are rare; the first routine_name is the callee.
          const routine = routines[0];
          if (!routine) break;
          const raw = routine.getText();
          const at = raw.indexOf('@');
          const { arity, named } = argumentsOf(fnArgs[0]);
          out.calls.push({
            ownerPath: [...scope],
            ownerIndex: ownerIndex(),
            line: routine.start!.line,
            column: routine.start!.column,
            nameParts: splitDotted(at >= 0 ? raw.slice(0, at) : raw),
            nameTokens: nameCtxs(routine).map(nameTokenOf),
            arity: arity ?? 0,
            namedArguments: named,
            form: 'statement',
            dbLink: at >= 0 ? raw.slice(at + 1).toUpperCase() : undefined,
          });
          break;
        }
        case P.RULE_general_element: {
          // `pkg.fn(args)` / `fn(args)` in an expression. Only the outermost
          // general_element; collection indexing `arr(i)` looks identical and
          // is disambiguated later by name resolution against definitions.
          if (ctx.parent?.ruleIndex === P.RULE_general_element) break;
          const parts = flattenGeneralElement(ctx);
          if (parts.length === 0) break;
          const last = parts[parts.length - 1]!;
          const fnArg = childRule(last, P.RULE_function_argument);
          if (!fnArg) {
            for (const p of parts) {
              const id = childRule(p, P.RULE_id_expression);
              if (id) out.expressionNames.push(nameTokenOf(id));
            }
            break;
          }
          const idCtxs = parts.map((p) => childRule(p, P.RULE_id_expression));
          if (idCtxs.some((c) => c === undefined)) break;
          const names = idCtxs.map((c) => normaliseIdentifier(c!.getText()));
          const { arity, named } = argumentsOf(fnArg);
          out.calls.push({
            ownerPath: [...scope],
            ownerIndex: ownerIndex(),
            line: ctx.start!.line,
            column: ctx.start!.column,
            nameParts: names,
            nameTokens: idCtxs.map((c) => nameTokenOf(c!)),
            arity,
            namedArguments: named,
            form: 'expression',
          });
          break;
        }
        case P.RULE_tableview_name: {
          const kind = accessKindOf(ctx);
          if (!kind) break;
          const raw = ctx.getText();
          const at = raw.indexOf('@');
          const parts = splitDotted(at >= 0 ? raw.slice(0, at) : raw);
          const table = parts[parts.length - 1]!;
          if (PSEUDO_TABLES.has(table)) break;
          if (parts.length === 1 && cteNamesAbove(ctx).has(table)) break;
          out.accesses.push({
            ownerPath: [...scope],
            ownerIndex: ownerIndex(),
            line: ctx.start!.line,
            column: ctx.start!.column,
            table,
            schema: parts.length > 1 ? parts[parts.length - 2] : undefined,
            dbLink: at >= 0 ? raw.slice(at + 1).toUpperCase() : undefined,
            kind,
          });
          break;
        }
        case P.RULE_execute_immediate: {
          const expr = childRule(ctx, P.RULE_expression);
          const text = expr?.getText() ?? '';
          out.dynamicSql.push({
            ownerPath: [...scope],
            ownerIndex: ownerIndex(),
            line: ctx.start!.line,
            literal: /^'[\s\S]*'$/.test(text) ? text.slice(1, -1).replace(/''/g, "'") : undefined,
          });
          break;
        }
      }
    },
    exitEveryRule(ctx: ParserRuleContext) {
      if (SCOPE_RULES.has(ctx.ruleIndex)) {
        scope.pop();
        owners.pop();
      }
    },
  };
  ParseTreeWalker.DEFAULT.walk(listener, segment.tree);
}

/** `a.b(x).c` → [a, b(x), c] general_element_part nodes in source order. */
function flattenGeneralElement(ctx: ParserRuleContext): ParserRuleContext[] {
  const out: ParserRuleContext[] = [];
  for (const c of ctx.children) {
    if (!(c instanceof ParserRuleContext)) continue;
    if (c.ruleIndex === P.RULE_general_element) out.push(...flattenGeneralElement(c));
    else if (c.ruleIndex === P.RULE_general_element_part) out.push(c);
  }
  return out;
}

// ─── regex fallback ───────────────────────────────────────────────────────

const FALLBACK_UNIT =
  /^[ \t]*create\s+(?:or\s+replace\s+)?(?:(?:non)?editionable\s+)?(package\s+body|package|procedure|function|trigger)\s+((?:"[^"]+"|[\w$#]+)(?:\.(?:"[^"]+"|[\w$#]+))?)/gim;
const FALLBACK_SUBPROGRAM = /^[ \t]*(procedure|function)\s+("[^"]+"|[\w$#]+)/gim;

/** Offset → line lookup built once per segment (binary search over line starts). */
function lineLocator(text: string, firstLine: number): (offset: number) => number {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return firstLine + lo;
  };
}

/**
 * Regex-level definitions for a segment whose tree is missing or erroneous.
 * Only names the tree did not already yield are added.
 */
function fallbackDefinitions(segment: PlSqlSegment, known: ReadonlySet<string>): PlSqlDefinition[] {
  const out: PlSqlDefinition[] = [];
  const text = segment.text;
  const lineAt = lineLocator(text, segment.startLine);
  let unit: { name: string; kind: PlSqlDefKind; isSpec: boolean } | undefined;
  for (const m of text.matchAll(FALLBACK_UNIT)) {
    const kindText = m[1]!.toLowerCase().replace(/\s+/g, ' ');
    const parts = splitDotted(m[2]!);
    const kind: PlSqlDefKind = kindText.startsWith('package')
      ? 'package'
      : (kindText as PlSqlDefKind);
    const name = parts[parts.length - 1]!;
    const line = lineAt(m.index!);
    if (!known.has(`|${name}`)) {
      out.push(
        makeFallback(
          kind,
          name,
          [],
          line,
          segment.endLine,
          parts.length > 1 ? parts[0] : undefined,
          kindText === 'package',
        ),
      );
    }
    unit = { name, kind, isSpec: kindText === 'package' };
    break; // one top-level unit per segment
  }
  if (unit?.kind !== 'package') return out;
  // Nesting from `END <name>;` spans: a routine that starts inside another
  // routine's span is local to it, not a package member. Spec declarations
  // have no bodies, so everything in a spec is package-level.
  const routines = [...text.matchAll(FALLBACK_SUBPROGRAM)].map((m) => {
    const name = normaliseIdentifier(m[2]!);
    let end = -1;
    if (!unit!.isSpec) {
      const label = m[2]!.startsWith('"') ? m[2]!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : name;
      const close = new RegExp(
        `^[ \\t]*end[ \\t]+${label.replace(/[$#]/g, '\\$&')}[ \\t]*;`,
        'gim',
      );
      close.lastIndex = m.index!;
      end = close.exec(text)?.index ?? -1;
    }
    return { name, kind: m[1]!.toLowerCase() as PlSqlDefKind, start: m.index!, end };
  });
  const pathOf = (i: number): string[] => {
    const r = routines[i]!;
    let parent = -1;
    for (let j = 0; j < i; j++) {
      const p = routines[j]!;
      if (p.end > r.start && (parent < 0 || p.start > routines[parent]!.start)) parent = j;
    }
    return parent < 0 ? [unit!.name] : [...pathOf(parent), routines[parent]!.name];
  };
  routines.forEach((r, i) => {
    const ownerPath = pathOf(i);
    if (known.has(`${ownerPath.join('\0')}|${r.name}`)) return;
    const line = lineAt(r.start);
    out.push(makeFallback(r.kind, r.name, ownerPath, line, line, undefined, unit!.isSpec));
  });
  return out;
}

function makeFallback(
  kind: PlSqlDefKind,
  name: string,
  ownerPath: string[],
  startLine: number,
  endLine: number,
  schema: string | undefined,
  isSpec: boolean,
): PlSqlDefinition {
  return {
    kind,
    name,
    schema,
    ownerPath,
    startLine,
    startColumn: 0,
    endLine,
    endColumn: 0,
    nameLine: startLine,
    nameColumn: 0,
    nameLength: name.length,
    endLabels: [],
    parameters: [],
    isSpec,
    declarationOnly: isSpec && kind !== 'package',
    fromFallback: true,
  };
}

// ─── entry point ──────────────────────────────────────────────────────────

export function extractPlSqlFacts(
  source: string,
  options: { segmentDeadlineMs?: number } = {},
): PlSqlFileFacts {
  const parsed = parsePlSqlSource(source, options);
  const out = {
    definitions: [] as PlSqlDefinition[],
    calls: [] as PlSqlCallSite[],
    accesses: [] as PlSqlTableAccess[],
    dynamicSql: [] as PlSqlDynamicSqlSite[],
    expressionNames: [] as PlSqlNameToken[],
  };
  let segmentsWithErrors = 0;
  let segmentsTimedOut = 0;
  let firstError: string | undefined;
  for (const segment of parsed.segments) {
    const before = out.definitions.length;
    extractSegment(segment, out);
    if (segment.syntaxErrors > 0) {
      segmentsWithErrors++;
      if (segment.mode === 'timeout') segmentsTimedOut++;
      firstError ??= segment.firstError;
      const known = new Set(
        out.definitions.slice(before).map((d) => `${d.ownerPath.join('\0')}|${d.name}`),
      );
      out.definitions.push(...fallbackDefinitions(segment, known));
    }
  }
  return {
    ...out,
    scriptIncludes: parsed.scriptIncludes,
    sqlplusCommands: parsed.sqlplusCommands,
    segments: parsed.segments.length,
    segmentsWithErrors,
    segmentsTimedOut,
    firstError,
  };
}

// ─── tokens for rename ────────────────────────────────────────────────────

export interface PlSqlLexedToken {
  readonly text: string;
  readonly line: number;
  readonly column: number;
}

/**
 * Default-channel tokens of pre-processed text (comments, whitespace and EOF
 * excluded). Lives here so rename reaches the lexer through the lazily loaded
 * parser module rather than importing it at start-up.
 */
export function lexPlSqlTokens(preprocessed: string): PlSqlLexedToken[] {
  const lexer = new PlSqlLexer(CharStream.fromString(preprocessed));
  lexer.removeErrorListeners();
  const stream = new CommonTokenStream(lexer);
  stream.fill();
  return stream
    .getTokens()
    .filter((t) => t.channel === Token.DEFAULT_CHANNEL && t.type !== Token.EOF)
    .map((t) => ({ text: t.text ?? '', line: t.line, column: t.column }));
}
