/** Written COBOL declarations and references shared by capture and binding resolution. */
import type { Capture, CaptureMatch, NodeLabel, Range } from 'gitnexus-shared';
import {
  extractCobolSymbolsWithRegex,
  preprocessCobolSource,
  type CobolRegexResults,
} from '../../cobol/cobol-preprocessor.js';
import { tokenizeCobol, type CobolToken } from './flow-source.js';

type Program = CobolRegexResults['programs'][number];
export interface CobolDeclaration {
  readonly token: CobolToken;
  readonly type: NodeLabel;
  readonly range: Range;
  readonly scopeRange?: Range;
  readonly program?: Program;
  readonly parents: readonly CobolDeclaration[];
  readonly qualifiedName: string;
  readonly parameterCount?: number;
}
export interface CobolReference {
  readonly token: CobolToken;
  readonly kind: 'program' | 'procedure' | 'data';
  readonly program?: Program;
  /** The first token is the referenced name; the rest are its OF/IN qualifiers. */
  readonly chain: readonly CobolToken[];
  readonly chainIndex: number;
  readonly isCall?: boolean;
  readonly localProgram?: boolean;
}
export interface CobolSemanticSource {
  readonly tokens: readonly CobolToken[];
  readonly declarations: readonly CobolDeclaration[];
  readonly references: readonly CobolReference[];
  /** Written words whose declaration-clause role has not been proven. */
  readonly unclassified: readonly CobolToken[];
  readonly dynamicCalls: boolean;
  readonly extracted: CobolRegexResults;
}
export const cobolTokenRange = (token: CobolToken): Range => ({
  startLine: token.line,
  endLine: token.line,
  startCol: token.column,
  endCol: token.column + token.text.length,
});
export const cobolRangeKey = (range: Range): string =>
  `${range.startLine}:${range.startCol}:${range.endLine}:${range.endCol}`;
const tokenKey = (token: CobolToken): string => cobolRangeKey(cobolTokenRange(token));
const capture = (name: string, range: Range, text: string): Capture => ({ name, range, text });

/** Reserved syntax cannot be renamed to a data/procedure/program identifier. */
export const COBOL_RESERVED = new Set(
  (
    'ACCEPT ADD ADDRESS ADVANCING AFTER ALL ALSO ALTER AND ARE ASCENDING ASSIGN AT AUTHOR BEFORE ' +
    'BINARY BY CALL CANCEL CLOSE COMP COMP-1 COMP-2 COMP-3 COMP-4 COMP-5 COMPUTATIONAL COMPUTE ' +
    'CONFIGURATION CONTENT CONTINUE CORR CORRESPONDING DATA DATE-COMPILED DATE-WRITTEN ' +
    'DECLARATIVES DELETE DELIMITED DEPENDING DESCENDING DISPLAY DIVIDE DIVISION ELSE END ' +
    'END-ACCEPT END-ADD END-CALL END-COMPUTE END-DELETE END-DISPLAY END-DIVIDE END-EVALUATE ' +
    'END-IF END-MULTIPLY END-PERFORM END-READ END-REWRITE END-SEARCH END-START END-STRING ' +
    'END-SUBTRACT END-UNSTRING END-WRITE ENTRY ENVIRONMENT EQUAL EQUALS EVALUATE EXCEPTION EXEC ' +
    'EXIT EXTEND EXTERNAL FALSE FD FILE FILE-CONTROL FILLER FIRST FOREVER FROM FUNCTION ' +
    'FUNCTION-POINTER GIVING GLOBAL GO GOBACK GOTO GREATER HIGH-VALUE HIGH-VALUES ' +
    'IDENTIFICATION IF IN INDEXED INITIALIZE INPUT INPUT-OUTPUT INSPECT INSTALLATION ' +
    'INTO INVALID IS JUSTIFIED KEY LAST LEADING LENGTH LESS LINKAGE LOCAL-STORAGE ' +
    'LOW-VALUE LOW-VALUES MERGE MODE MOVE MULTIPLY NATIONAL NEXT NO NOT NULL NULLS ' +
    'OBJECT-COMPUTER OCCURS OF OMITTED ON OPEN OR ORGANIZATION OTHER OUTPUT OVERFLOW ' +
    'PACKED-DECIMAL PERFORM PIC PICTURE POINTER POSITIVE PROCEDURE PROCEDURE-POINTER PROGRAM ' +
    'PROGRAM-ID QUOTE QUOTES READ REDEFINES REFERENCE RELEASE REMAINDER RENAMES REPLACING ' +
    'RETURN RETURNING REVERSE REWIND REWRITE ROUNDED RUN SAME SCREEN SD SEARCH SECTION ' +
    'SELECT SENTENCE SEPARATE SEQUENCE SET SIGN SIZE SORT SOURCE-COMPUTER SPACE SPACES ' +
    'SPECIAL-NAMES STANDARD START STOP STRING SUBTRACT SYNC SYNCHRONIZED TALLYING TEST THAN ' +
    'THEN THROUGH THRU TIMES TO TRAILING TRUE TYPE UNSTRING UNTIL UP UPON USAGE USE USING ' +
    'VALUE VALUES VARYING WHEN WITH WORKING-STORAGE WRITE ZERO ZEROES ZEROS COPY'
  ).split(' '),
);

export function readCobolSemanticSource(source: string, filePath: string): CobolSemanticSource {
  const extracted = extractCobolSymbolsWithRegex(preprocessCobolSource(source), filePath);
  const tokens = tokenizeCobol(source);
  const lines = source.split(/\r?\n/);
  const lineRange = (start: number, end = start): Range => ({
    startLine: start,
    startCol: 0,
    endLine: end,
    endCol: lines[end - 1]?.length ?? 0,
  });
  const programAt = (line: number): Program | undefined =>
    extracted.programs
      .filter((p) => p.startLine <= line && p.endLine >= line)
      .sort((a, b) => b.nestingDepth - a.nestingDepth || b.startLine - a.startLine)[0];
  const programKey = (program?: Program) => `program:${program?.startLine ?? 0}`;
  const tokenAt = (line: number, name: string) =>
    tokens.find((t) => t.line === line && t.upper === name.toUpperCase());
  const declarations: CobolDeclaration[] = [];
  const declared = new Set<string>();
  const add = (declaration: CobolDeclaration) => {
    declarations.push(declaration);
    declared.add(tokenKey(declaration.token));
  };
  for (const [index, program] of extracted.programs.entries()) {
    const tokenIndex = tokens.findIndex(
      (t, i) =>
        t.upper === 'PROGRAM-ID' &&
        tokens[i + 2]?.upper === program.name.toUpperCase() &&
        t.line === program.startLine,
    );
    const token = tokens[tokenIndex + 2];
    if (tokenIndex < 0 || !token) continue;
    add({
      token,
      type: 'Module',
      program,
      parents: [],
      qualifiedName: program.name.toUpperCase(),
      // The established graph models the primary module as the entire file.
      range: lineRange(
        index === 0 ? 1 : program.startLine,
        index === 0 ? lines.length : program.endLine,
      ),
      scopeRange: lineRange(index === 0 ? 1 : program.startLine, program.endLine),
      ...(program.procedureUsing ? { parameterCount: program.procedureUsing.length } : {}),
    });
  }
  for (const [index, section] of extracted.sections.entries()) {
    const token = tokenAt(section.line, section.name);
    if (!token) continue;
    const program = programAt(section.line);
    const end = extracted.sections[index + 1]?.line
      ? extracted.sections[index + 1]!.line - 1
      : lines.length;
    const nextProgram = extracted.programs.find((item) => item.startLine > token.line)?.startLine;
    add({
      token,
      type: 'Namespace',
      program,
      parents: [],
      qualifiedName: `${program ? `${program.name.toUpperCase()}:` : ''}${token.upper}`,
      range: lineRange(section.line, end),
      scopeRange: lineRange(
        section.line,
        Math.min(end, nextProgram === undefined ? end : nextProgram - 1, program?.endLine ?? end),
      ),
    });
  }
  for (const [index, paragraph] of extracted.paragraphs.entries()) {
    const token = tokenAt(paragraph.line, paragraph.name);
    if (!token) continue;
    const program = programAt(paragraph.line);
    const section = declarations
      .filter((d) => d.type === 'Namespace' && d.program === program && d.token.line < token.line)
      .at(-1);
    const end = extracted.paragraphs[index + 1]?.line
      ? extracted.paragraphs[index + 1]!.line - 1
      : lines.length;
    const nextSection = extracted.sections.find((item) => item.line > token.line)?.line;
    const nextProgram = extracted.programs.find((item) => item.startLine > token.line)?.startLine;
    add({
      token,
      type: 'Function',
      program,
      parents: section ? [section] : [],
      qualifiedName: `${programKey(program)}.${section ? `section:${section.token.line}` : 'procedure'}.${token.upper}`,
      range: lineRange(token.line, end),
      scopeRange: lineRange(
        token.line,
        Math.min(
          end,
          nextSection === undefined ? end : nextSection - 1,
          nextProgram === undefined ? end : nextProgram - 1,
          section?.scopeRange?.endLine ?? end,
          program?.endLine ?? end,
        ),
      ),
    });
  }
  const dataParents: {
    item: CobolRegexResults['dataItems'][number];
    declaration: CobolDeclaration;
  }[] = [];
  let previousProgram: Program | undefined;
  let previousSection: string | undefined;
  for (const item of extracted.dataItems) {
    const token = tokenAt(item.line, item.name);
    if (!token) continue;
    const program = programAt(item.line);
    if (
      program !== previousProgram ||
      item.section !== previousSection ||
      [1, 77].includes(item.level)
    )
      dataParents.length = 0;
    previousProgram = program;
    previousSection = item.section;
    while (dataParents.length && dataParents.at(-1)!.item.level >= item.level) dataParents.pop();
    const parents = [...dataParents].reverse().map((p) => p.declaration);
    const declaration: CobolDeclaration = {
      token,
      type: 'Property',
      range: lineRange(item.line),
      program,
      parents,
      qualifiedName: `${programKey(program)}.${item.section}.${[...parents]
        .reverse()
        .map((p) => p.token.upper)
        .concat(token.upper)
        .join('.')}`,
    };
    if (token.upper !== 'FILLER') add(declaration);
    if (item.level !== 88) dataParents.push({ item, declaration });
  }

  const references: CobolReference[] = [];
  const used = new Set<string>(declared);
  const addReference = (
    chain: readonly CobolToken[],
    kind: CobolReference['kind'],
    program = programAt(chain[0]!.line),
    extra?: Pick<CobolReference, 'isCall' | 'localProgram'>,
  ) => {
    chain.forEach((token, chainIndex) => {
      if (used.has(tokenKey(token))) return;
      used.add(tokenKey(token));
      references.push({ token, kind, program, chain, chainIndex, ...extra });
    });
  };
  const qualified = (index: number): { chain: CobolToken[]; end: number } => {
    const chain = [tokens[index]!];
    while (
      ['OF', 'IN'].includes(tokens[index + 1]?.upper ?? '') &&
      tokens[index + 2]?.kind === 'word'
    ) {
      chain.push(tokens[index + 2]!);
      index += 2;
    }
    return { chain, end: index };
  };
  const literalName = (token: CobolToken): CobolToken => ({
    ...token,
    kind: 'word',
    column: token.column + 1,
    text: token.text.slice(1, -1),
    upper: token.upper.slice(1, -1),
  });
  const procedureLines = new Map<Program | undefined, number>();
  for (let i = 0; i < tokens.length; i++)
    if (tokens[i]!.upper === 'PROCEDURE' && tokens[i + 1]?.upper === 'DIVISION')
      procedureLines.set(programAt(tokens[i]!.line), tokens[i]!.line);
  let dynamicCalls = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const procedureLine = procedureLines.get(programAt(token.line));
    if (procedureLine === undefined || token.line < procedureLine) {
      // These clauses name data items even though they precede PROCEDURE
      // DIVISION. Keep their OF/IN chain for the existing data resolver.
      if (
        (token.upper === 'STATUS' &&
          ['FILE', 'SORT', 'CRT'].includes(tokens[i - 1]?.upper ?? '')) ||
        (token.upper === 'KEY' && ['RECORD', 'RELATIVE'].includes(tokens[i - 1]?.upper ?? ''))
      ) {
        const operand = i + (tokens[i + 1]?.upper === 'IS' ? 2 : 1);
        if (tokens[operand]?.kind === 'word' && !COBOL_RESERVED.has(tokens[operand]!.upper))
          addReference(qualified(operand).chain, 'data');
      }
      if (token.upper === 'PIC' || token.upper === 'PICTURE') {
        // A picture is one contiguous character string, not a data reference.
        // Do not swallow following clauses or an unrecognized word.
        let next = i + (tokens[i + 1]?.upper === 'IS' ? 2 : 1);
        while (tokens[next] && /^[AX9ZSVPBNCRDEG0-9()+,\-/$*.]+$/i.test(tokens[next]!.text)) {
          used.add(tokenKey(tokens[next]!));
          const current = tokens[next++]!;
          if (
            tokens[next]?.line !== current.line ||
            tokens[next]?.column !== current.column + current.text.length
          )
            break;
        }
      }
    }
    if (
      token.upper === 'END' &&
      tokens[i + 1]?.upper === 'PROGRAM' &&
      tokens[i + 2]?.kind === 'word'
    ) {
      addReference([tokens[i + 2]!], 'program', programAt(token.line), { localProgram: true });
    }
    if (
      ['CALL', 'CANCEL'].includes(token.upper) ||
      (token.upper === 'ENTRY' && tokens[i - 1]?.upper === 'TO')
    ) {
      const target = tokens[i + 1];
      if (target?.kind === 'literal') addReference([literalName(target)], 'program');
      else if (token.upper === 'CALL' || token.upper === 'CANCEL') {
        dynamicCalls = true;
        if (target?.kind === 'word')
          addReference(qualified(i + 1).chain, 'data', programAt(token.line), {
            isCall: token.upper === 'CALL',
          });
      }
      if (token.upper === 'CANCEL')
        for (let next = i + 2; tokens[next]?.kind === 'literal'; next++)
          addReference([literalName(tokens[next]!)], 'program');
    }
    if (token.upper === 'PERFORM' && tokens[i - 1]?.upper !== 'EXIT') {
      const target = tokens[i + 1];
      if (
        target?.kind === 'word' &&
        !COBOL_RESERVED.has(target.upper) &&
        tokens[i + 2]?.upper !== 'TIMES'
      ) {
        const first = qualified(i + 1);
        addReference(first.chain, 'procedure');
        if (
          ['THRU', 'THROUGH'].includes(tokens[first.end + 1]?.upper ?? '') &&
          tokens[first.end + 2]?.kind === 'word'
        )
          addReference(qualified(first.end + 2).chain, 'procedure');
      }
    }
    if (token.upper === 'GO' || token.upper === 'GOTO') {
      let next = i + (tokens[i + 1]?.upper === 'TO' ? 2 : 1);
      while (tokens[next]?.kind === 'word' && !COBOL_RESERVED.has(tokens[next]!.upper)) {
        const target = qualified(next);
        addReference(target.chain, 'procedure');
        next = target.end + 1;
      }
    }
    if (
      ['REDEFINES', 'RENAMES'].includes(token.upper) ||
      (token.upper === 'ON' && tokens[i - 1]?.upper === 'DEPENDING')
    ) {
      if (tokens[i + 1]?.kind === 'word') {
        const reference = qualified(i + 1);
        addReference(reference.chain, 'data');
        if (
          token.upper === 'RENAMES' &&
          ['THRU', 'THROUGH'].includes(tokens[reference.end + 1]?.upper ?? '') &&
          tokens[reference.end + 2]?.kind === 'word'
        )
          addReference(qualified(reference.end + 2).chain, 'data');
      }
    }
    if (token.upper === 'FUNCTION' && tokens[i + 1]?.kind === 'word')
      used.add(tokenKey(tokens[i + 1]!));
  }
  const unclassified: CobolToken[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind !== 'word' || used.has(tokenKey(token)) || COBOL_RESERVED.has(token.upper))
      continue;
    const program = programAt(token.line);
    // Known syntax and clause operands were classified above. Preserve any
    // remaining declaration-region word as unknown, never as unrelated text.
    const procedureLine = procedureLines.get(program);
    if (procedureLine === undefined || token.line < procedureLine) {
      unclassified.push(token);
      continue;
    }
    const reference = qualified(i);
    addReference(reference.chain, 'data', program);
    i = reference.end;
  }
  return { tokens, declarations, references, unclassified, dynamicCalls, extracted };
}

export function cobolSemanticCaptures(facts: CobolSemanticSource): CaptureMatch[] {
  const result: CaptureMatch[] = [];
  for (const declaration of facts.declarations) {
    const { token, range, type, qualifiedName, scopeRange } = declaration;
    const nameRange = cobolTokenRange(token);
    const tag = `@declaration.${type === 'Module' ? 'program' : type.toLowerCase()}`;
    const scope = type === 'Module' ? 'module' : type === 'Namespace' ? 'namespace' : 'function';
    result.push({
      [tag]: capture(tag, range, token.upper),
      '@declaration.name': capture('@declaration.name', nameRange, token.upper),
      '@declaration.qualified_name': capture(
        '@declaration.qualified_name',
        nameRange,
        qualifiedName,
      ),
      '@declaration.binding-name': capture(
        '@declaration.binding-name',
        nameRange,
        type === 'Property' ? qualifiedName : token.upper,
      ),
      ...(scopeRange
        ? { [`@scope.${scope}`]: capture(`@scope.${scope}`, scopeRange, token.upper) }
        : {}),
      ...(declaration.parameterCount !== undefined
        ? {
            '@declaration.parameter-count': capture(
              '@declaration.parameter-count',
              nameRange,
              String(declaration.parameterCount),
            ),
          }
        : {}),
    });
  }
  for (const ref of facts.references) {
    const range = cobolTokenRange(ref.token);
    const tag =
      (ref.kind === 'data' && !ref.isCall) || ref.chainIndex > 0
        ? '@reference.read'
        : '@reference.call';
    const call = facts.extracted.calls.find(
      (call) => call.line === ref.token.line && call.target.toUpperCase() === ref.token.upper,
    );
    const arity = call?.parameters?.length;
    // Callable-flow sites use the established statement anchor at column 0;
    // the exact written name remains independent in @reference.name.
    result.push({
      [tag]: capture(tag, call ? { ...range, startCol: 0 } : range, ref.token.upper),
      '@reference.name': capture('@reference.name', range, ref.token.upper),
      ...(arity ? { '@reference.arity': capture('@reference.arity', range, String(arity)) } : {}),
    });
  }
  return result;
}

/** A qualified source name denotes its declaration, never the group's storage descendants. */
export function resolveCobolReference(
  reference: CobolReference,
  source: CobolSemanticSource,
  workspace: readonly CobolSemanticSource[],
): CobolDeclaration[] {
  const { chain, kind, program } = reference;
  const name = chain[0]!.upper;
  const qualifiers = chain.slice(1).map((token) => token.upper);
  let candidates = (
    kind === 'program' ? workspace.flatMap((file) => file.declarations) : source.declarations
  ).filter(
    (d) =>
      d.token.upper === name &&
      (kind === 'program'
        ? d.type === 'Module' && (!reference.localProgram || d.program === program)
        : d.program === program &&
          (kind === 'data'
            ? d.type === 'Property'
            : d.type === 'Function' || d.type === 'Namespace')),
  );
  candidates = candidates.filter((d) => {
    let position = 0;
    for (const qualifier of qualifiers) {
      const next = d.parents.findIndex(
        (parent, index) => index >= position && parent.token.upper === qualifier,
      );
      if (next < 0) return false;
      position = next + 1;
    }
    return true;
  });
  if (kind === 'procedure' && candidates.length > 1 && !qualifiers.length) {
    const section = source.declarations.find(
      (d) =>
        d.type === 'Namespace' &&
        d.program === program &&
        d.scopeRange &&
        d.scopeRange.startLine <= reference.token.line &&
        d.scopeRange.endLine >= reference.token.line,
    );
    const local = candidates.filter((d) => d.parents.includes(section!));
    if (local.length) candidates = local;
  }
  if (reference.chainIndex === 0) return candidates;
  const qualifier = chain[reference.chainIndex]!.upper;
  return [
    ...new Set(
      candidates.flatMap((d) => d.parents.filter((parent) => parent.token.upper === qualifier)),
    ),
  ];
}
