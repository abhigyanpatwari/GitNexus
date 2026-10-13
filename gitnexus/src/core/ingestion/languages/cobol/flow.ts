/**
 * COBOL PROCEDURE DIVISION → the shared serializable CFG/def-use substrate.
 *
 * A program, not a paragraph, owns the executable region: ordinary flow falls
 * through paragraph boundaries. PERFORM activates a return at the end of its
 * paragraph/section/THRU range. Expanding reachable (instruction, return-stack)
 * states keeps different return continuations separate without pretending that
 * paragraphs are ordinary functions. Recursive/excessive expansion fails closed.
 */
import { generateId } from '../../../../lib/utils.js';
import {
  extractCobolSymbolsWithRegex,
  type CobolRegexResults,
} from '../../cobol/cobol-preprocessor.js';
import { CfgBuilder, CfgNestingDepthError } from '../../cfg/cfg-builder.js';
import type { CollectedCfgs } from '../../cfg/collect.js';
import type { CfgEdgeKind, FunctionCfg, StatementFacts } from '../../cfg/types.js';
import { CobolHarvester } from './flow-harvest.js';
import {
  CobolFlowUnsupported,
  CobolProcedureParser,
  tokenizeCobol,
  tokenText,
  isCobolParagraphHeading,
  type CobolStatement,
  type CobolToken,
} from './flow-source.js';

interface Arc {
  readonly to: number;
  readonly kind: CfgEdgeKind;
}
interface Instruction {
  readonly tokens: readonly CobolToken[];
  readonly facts?: StatementFacts;
  readonly edges: Arc[];
  readonly boundary?: boolean;
  readonly perform?: {
    readonly start: number;
    readonly end: number;
    readonly continuation: number;
  };
}
interface ProcedureRange {
  readonly name: string;
  readonly section?: string;
  readonly kind: 'paragraph' | 'section';
  readonly start: number;
  readonly end: number;
}
interface CompileContext {
  readonly paragraphEnd: number;
  readonly sectionEnd?: number;
  readonly section?: string;
  readonly breakTarget?: number;
  readonly continueTarget?: number;
}

class CobolFlowCompiler {
  readonly instructions: Instruction[] = [];
  readonly ranges: ProcedureRange[] = [];
  constructor(private readonly harvest: CobolHarvester) {}

  instruction(
    tokens: readonly CobolToken[],
    edges: Arc[],
    facts?: StatementFacts,
    boundary = false,
  ): number {
    const index = this.instructions.length;
    this.instructions.push({ tokens, edges, facts, ...(boundary ? { boundary } : {}) });
    return index;
  }

  private resolve(name: string, section?: string): ProcedureRange {
    const [base, qualifier] = name.split(' OF ');
    let matches = this.ranges.filter(
      (r) => r.name === base && (!qualifier || r.section === qualifier),
    );
    if (matches.length > 1 && section) {
      const local = matches.filter((r) => r.section === section);
      if (local.length) matches = local;
    }
    if (matches.length !== 1) throw new CobolFlowUnsupported('unresolved procedure ' + name);
    return matches[0]!;
  }

  sequence(statements: readonly CobolStatement[], next: number, context: CompileContext): number {
    for (let i = statements.length - 1; i >= 0; i--)
      next = this.statement(statements[i]!, next, context);
    return next;
  }

  private statement(stmt: CobolStatement, next: number, context: CompileContext): number {
    const tokens = stmt.tokens;
    switch (stmt.kind) {
      case 'if':
        return this.instruction(
          tokens,
          [
            { to: this.sequence(stmt.then, next, context), kind: 'cond-true' },
            { to: this.sequence(stmt.otherwise, next, context), kind: 'cond-false' },
          ],
          this.harvest.facts(tokens, tokens.slice(1)),
        );
      case 'evaluate': {
        const edges = stmt.cases.map((c) => ({
          to: this.sequence(c.body, next, context),
          kind: 'switch-case' as const,
        }));
        if (!stmt.cases.some((c) => c.other)) edges.push({ to: next, kind: 'switch-case' });
        return this.instruction(
          tokens,
          edges,
          this.harvest.facts(tokens, [...tokens.slice(1), ...stmt.cases.flatMap((c) => c.tests)]),
        );
      }
      case 'perform':
        return this.perform(stmt, next, context);
      case 'simple': {
        const verb = tokens[0]!.upper;
        let to = next;
        let kind: CfgEdgeKind = 'seq';
        if (
          verb === 'GOBACK' ||
          (verb === 'STOP' && tokens[1]?.upper === 'RUN') ||
          (verb === 'EXIT' && tokens[1]?.upper === 'PROGRAM')
        ) {
          to = -1;
          kind = 'return';
        } else if (verb === 'STOP') {
          throw new CobolFlowUnsupported('non-RUN STOP');
        } else if (verb === 'GO' || verb === 'GOTO') {
          const name = tokens.slice(tokens[1]?.upper === 'TO' ? 2 : 1);
          if (
            !name.length ||
            name.some((t) => t.upper === 'DEPENDING') ||
            (name.length > 1 && !['OF', 'IN'].includes(name[1]!.upper))
          ) {
            throw new CobolFlowUnsupported('computed GO TO');
          }
          to = this.resolve(
            name.map((t) => (t.upper === 'IN' ? 'OF' : t.upper)).join(' '),
            context.section,
          ).start;
        } else if (verb === 'EXIT' && tokens.length > 1) {
          switch (tokens[1]!.upper) {
            case 'PARAGRAPH':
              to = context.paragraphEnd;
              break;
            case 'SECTION':
              if (context.sectionEnd === undefined)
                throw new CobolFlowUnsupported('EXIT SECTION outside section');
              to = context.sectionEnd;
              break;
            case 'PERFORM':
              if (context.breakTarget === undefined)
                throw new CobolFlowUnsupported('EXIT PERFORM outside inline PERFORM');
              to = tokens[2]?.upper === 'CYCLE' ? context.continueTarget! : context.breakTarget;
              kind = tokens[2]?.upper === 'CYCLE' ? 'continue' : 'break';
              break;
            default:
              throw new CobolFlowUnsupported('unsupported EXIT');
          }
        }
        return this.instruction(tokens, [{ to, kind }], this.harvest.statement(tokens));
      }
    }
  }

  private perform(
    stmt: Extract<CobolStatement, { kind: 'perform' }>,
    next: number,
    context: CompileContext,
  ): number {
    const options = stmt.options;
    const until = options.findIndex((t) => t.upper === 'UNTIL');
    const varying = options.findIndex((t) => t.upper === 'VARYING');
    const times = options.findIndex((t) => t.upper === 'TIMES');
    const forever = options.some((t) => t.upper === 'FOREVER');
    const after = options.some((t, i) => t.upper === 'TEST' && options[i + 1]?.upper === 'AFTER');
    if (options.some((t, i) => t.upper === 'AFTER' && options[i - 1]?.upper !== 'TEST')) {
      throw new CobolFlowUnsupported('multiple VARYING controls');
    }
    if (options.length && until < 0 && times < 0 && !forever) {
      throw new CobolFlowUnsupported('unsupported PERFORM options');
    }
    if (times === 1 && options[0]?.kind === 'number' && Number(options[0].text) === 0) {
      return this.instruction(
        stmt.tokens,
        [{ to: next, kind: 'seq' }],
        this.harvest.facts(stmt.tokens),
      );
    }
    const iteration = (continuation: number, loopContext: CompileContext): number => {
      if (!stmt.target) return this.sequence(stmt.body, continuation, loopContext);
      const start = this.resolve(stmt.target, context.section);
      const end = stmt.thru ? this.resolve(stmt.thru, context.section) : start;
      if (end.end <= start.start) throw new CobolFlowUnsupported('reversed PERFORM range');
      const index = this.instructions.length;
      this.instructions.push({
        tokens: stmt.tokens,
        facts: this.harvest.facts(stmt.tokens),
        edges: [],
        perform: { start: start.start, end: end.end, continuation },
      });
      return index;
    };
    if (!options.length)
      return iteration(next, { ...context, breakTarget: next, continueTarget: next });
    const header = this.instruction(
      stmt.tokens,
      [],
      this.harvest.facts(
        stmt.tokens,
        until >= 0 ? options.slice(until + 1) : times >= 0 ? options.slice(0, times) : [],
      ),
    );
    // The explicit latch owns the loop-back kind; completion edges from a
    // performed procedure remain seq, preserving the generic jump-kind invariant.
    let latch = this.instruction([], [{ to: header, kind: 'loop-back' }]);
    let init: { tokens: readonly CobolToken[]; facts: StatementFacts } | undefined;
    if (varying >= 0) {
      const from = options.findIndex((t) => t.upper === 'FROM');
      const by = options.findIndex((t) => t.upper === 'BY');
      if (from < varying || by < from || until < by)
        throw new CobolFlowUnsupported('malformed VARYING');
      const variable = options.slice(varying + 1, from);
      init = {
        tokens: options.slice(varying + 1, by),
        facts: this.harvest.facts(stmt.tokens, options.slice(from + 1, by), variable),
      };
      latch = this.instruction(
        [...variable, ...options.slice(by, until)],
        [{ to: header, kind: 'loop-back' }],
        this.harvest.facts(stmt.tokens, options.slice(by + 1, until), variable, true),
      );
    }
    const body = iteration(latch, { ...context, breakTarget: next, continueTarget: latch });
    if (forever) this.instructions[header]!.edges.push({ to: body, kind: 'seq' });
    else if (until >= 0)
      this.instructions[header]!.edges.push(
        { to: next, kind: 'cond-true' },
        { to: body, kind: 'cond-false' },
      );
    else
      this.instructions[header]!.edges.push(
        { to: body, kind: 'cond-true' },
        { to: next, kind: 'cond-false' },
      );
    const entry = after ? body : header;
    return init ? this.instruction(init.tokens, [{ to: entry, kind: 'seq' }], init.facts) : entry;
  }
}

type Program = CobolRegexResults['programs'][number];

/** Expand only reachable contexts, never merge unrelated PERFORM return sites. */
function emitStates(compiler: CobolFlowCompiler, builder: CfgBuilder, entry: number): void {
  type Frame = { readonly start: number; readonly end: number; readonly continuation: number };
  type State = {
    readonly instruction: number;
    readonly stack: readonly Frame[];
    readonly block: number;
  };
  const states = new Map<string, State>();
  const pending: State[] = [];
  const MAX_STATES = 12000;
  const resolve = (
    initial: number,
    frames: readonly Frame[],
  ): { instruction: number; stack: readonly Frame[]; kind?: CfgEdgeKind } => {
    let instruction = initial;
    let stack = frames;
    let kind: CfgEdgeKind | undefined;
    const seen = new Set<string>();
    while (instruction >= 0) {
      const key = instruction + ':' + stack.map((f) => f.end + ',' + f.continuation).join('/');
      if (seen.has(key)) throw new CobolFlowUnsupported('empty procedure cycle');
      seen.add(key);
      const op = compiler.instructions[instruction]!;
      if (op.boundary && stack.at(-1)?.end === instruction) {
        const frame = stack.at(-1)!;
        stack = stack.slice(0, -1);
        instruction = frame.continuation;
      } else if (!op.tokens.length && op.edges.length === 1) {
        const edge = op.edges[0]!;
        if (edge.kind === 'loop-back') kind = edge.kind;
        instruction = edge.to;
      } else break;
    }
    return { instruction, stack, kind };
  };
  const state = (instruction: number, stack: readonly Frame[]): number => {
    if (instruction < 0) return builder.exitIndex;
    const key =
      instruction + ':' + stack.map((f) => f.start + ',' + f.end + ',' + f.continuation).join('/');
    const existing = states.get(key);
    if (existing) return existing.block;
    if (states.size >= MAX_STATES) throw new CobolFlowUnsupported('PERFORM state budget exceeded');
    const op = compiler.instructions[instruction]!;
    const first = op.tokens[0];
    const block = builder.newBlock(
      first?.line ?? 0,
      op.tokens.at(-1)?.line ?? first?.line ?? 0,
      tokenText(op.tokens),
      'normal',
      op.facts,
    );
    const value = { instruction, stack, block };
    states.set(key, value);
    pending.push(value);
    return block;
  };
  const first = resolve(entry, []);
  builder.edge(builder.entryIndex, state(first.instruction, first.stack), 'seq');
  for (let p = 0; p < pending.length; p++) {
    const current = pending[p]!;
    const op = compiler.instructions[current.instruction]!;
    if (op.perform) {
      if (current.stack.length >= 64 || current.stack.some((f) => f.start === op.perform!.start)) {
        throw new CobolFlowUnsupported('recursive PERFORM');
      }
      const target = resolve(op.perform.start, [...current.stack, op.perform]);
      builder.edge(current.block, state(target.instruction, target.stack), target.kind ?? 'seq');
    } else
      for (const arc of op.edges) {
        const target = resolve(arc.to, current.stack);
        builder.edge(
          current.block,
          state(target.instruction, target.stack),
          target.kind ?? arc.kind,
        );
      }
  }
}

function buildProgram(
  sourceTokens: readonly CobolToken[],
  extracted: CobolRegexResults,
  program: Program,
  filePath: string,
  maxFunctionLines: number,
): FunctionCfg | 'too-many-lines' | undefined {
  const children = extracted.programs.filter(
    (p) => p.startLine > program.startLine && p.endLine <= program.endLine,
  );
  const ownedLine = (line: number) =>
    line >= program.startLine &&
    line <= program.endLine &&
    !children.some((child) => line >= child.startLine && line <= child.endLine);
  const owned = sourceTokens.filter((t) => ownedLine(t.line));
  if (owned.some((t) => t.kind === 'invalid'))
    throw new CobolFlowUnsupported('unsupported source token');
  const procedure = owned.findIndex(
    (t, i) => t.upper === 'PROCEDURE' && owned[i + 1]?.upper === 'DIVISION',
  );
  if (procedure < 0) return undefined; // data-only copybook / incomplete program
  const headerEnd = owned.findIndex((t, i) => i > procedure && t.upper === '.');
  if (headerEnd < 0) throw new CobolFlowUnsupported('unterminated PROCEDURE DIVISION');
  let end = owned.findIndex(
    (t, i) =>
      i > headerEnd &&
      ((t.upper === 'IDENTIFICATION' && owned[i + 1]?.upper === 'DIVISION') ||
        (t.upper === 'END' && owned[i + 1]?.upper === 'PROGRAM')),
  );
  if (end < 0) end = owned.length;
  const tokens = owned.slice(headerEnd + 1, end);
  const firstLine = owned[procedure]!.line;
  const lastLine = tokens.at(-1)?.line ?? firstLine;
  if (maxFunctionLines > 0 && lastLine - firstLine + 1 > maxFunctionLines) return 'too-many-lines';
  const builder = new CfgBuilder(filePath, firstLine, lastLine, owned[procedure]!.column);
  const dataItems = extracted.dataItems.filter((i) => ownedLine(i.line) && i.line < firstLine);
  const lines = new Map<number, CobolToken[]>();
  for (const token of owned) {
    const line = lines.get(token.line) ?? [];
    line.push(token);
    lines.set(token.line, line);
  }
  // Supplement the regex tagger's two-character-name minimum with tokenized
  // declarations. Declaration coordinates still come directly from source.
  for (const [line, ts] of lines) {
    if (
      line >= firstLine ||
      ts[0]?.kind !== 'number' ||
      ts[0].text.length > 2 ||
      ts[1]?.kind !== 'word' ||
      dataItems.some((item) => item.line === line)
    )
      continue;
    const redefines = ts.findIndex((t) => t.upper === 'REDEFINES');
    dataItems.push({
      name: ts[1].text,
      level: Number(ts[0].text),
      line,
      section: 'unknown',
      ...(redefines >= 0 ? { redefines: ts[redefines + 1]?.text ?? '?' } : {}),
    });
  }
  dataItems.sort((a, b) => a.line - b.line);
  const harvest = new CobolHarvester(dataItems, sourceTokens, program.procedureUsing ?? []);
  const compiler = new CobolFlowCompiler(harvest);
  const headings = [
    ...extracted.sections.map((s) => ({ ...s, kind: 'section' as const })),
    ...extracted.paragraphs.map((p) => ({ ...p, kind: 'paragraph' as const })),
  ]
    .filter((h) => ownedLine(h.line) && h.line > firstLine && h.line <= lastLine)
    .sort((a, b) => a.line - b.line);
  for (const [line, ts] of lines) {
    if (
      line > firstLine &&
      line <= lastLine &&
      isCobolParagraphHeading(ts) &&
      !headings.some((h) => h.line === line)
    ) {
      headings.push({ name: ts[0]!.text, line, kind: 'paragraph' });
    }
  }
  headings.sort((a, b) => a.line - b.line);
  const starts = [firstLine, ...headings.map((h) => h.line)];
  const boundaries = [...starts, lastLine + 1].map(() =>
    compiler.instruction([], [], undefined, true),
  );
  let section: string | undefined;
  for (let i = 0; i < headings.length; i++) {
    const heading = headings[i]!;
    const name = heading.name.toUpperCase();
    if (heading.kind === 'section') section = name;
    const endIndex =
      heading.kind === 'paragraph'
        ? i + 2
        : headings.findIndex((h, j) => j > i && h.kind === 'section');
    compiler.ranges.push({
      name,
      kind: heading.kind,
      section: heading.kind === 'paragraph' ? section : undefined,
      start: boundaries[i + 1]!,
      end:
        heading.kind === 'paragraph'
          ? boundaries[endIndex]!
          : endIndex < 0
            ? boundaries.at(-1)!
            : boundaries[endIndex + 1]!,
    });
  }
  // A final boundary can either return the active PERFORM or fall off the program.
  compiler.instructions[boundaries.at(-1)!]!.edges.push({ to: -1, kind: 'seq' });
  for (let i = 0; i < starts.length; i++) {
    let chunk = tokens.filter(
      (t) => t.line >= starts[i]! && t.line < (starts[i + 1] ?? lastLine + 1),
    );
    if (i > 0) {
      const period = chunk.findIndex((t) => t.upper === '.');
      if (period < 0) throw new CobolFlowUnsupported('unterminated procedure heading');
      chunk = chunk.slice(period + 1);
    }
    const currentSection = compiler.ranges
      .filter((r) => r.kind === 'section' && r.start <= boundaries[i]! && r.end > boundaries[i]!)
      .at(-1);
    const body = new CobolProcedureParser(chunk).parse();
    const entry = compiler.sequence(body, boundaries[i + 1]!, {
      paragraphEnd: boundaries[i + 1]!,
      section: currentSection?.name,
      sectionEnd: currentSection?.end,
    });
    compiler.instructions[boundaries[i]!]!.edges.push({ to: entry, kind: 'seq' });
  }
  builder.attachFacts(builder.entryIndex, harvest.entryFacts(firstLine));
  emitStates(compiler, builder, boundaries[0]!);
  return {
    ...builder.finish(harvest.bindings),
    ownerId: generateId('Module', filePath + ':' + program.name),
  };
}

/** Standalone provider hook; isolated skips share the AST collector's telemetry. */
export function collectCobolSourceCfgs(
  sourceText: string,
  filePath: string,
  maxFunctionLines = 0,
): CollectedCfgs {
  const tokens = tokenizeCobol(sourceText);
  const extracted = extractCobolSymbolsWithRegex(sourceText, filePath);
  const cfgs: FunctionCfg[] = [];
  let tooManyLines = 0,
    tooDeeplyNested = 0,
    buildError = 0;
  for (const program of extracted.programs) {
    try {
      const result = buildProgram(tokens, extracted, program, filePath, maxFunctionLines);
      if (result === 'too-many-lines') tooManyLines++;
      else if (result) cfgs.push(result);
    } catch (error) {
      if (error instanceof CfgNestingDepthError) tooDeeplyNested++;
      else buildError++;
    }
  }
  return { cfgs, skipped: { tooManyLines, tooDeeplyNested, buildError } };
}
