/**
 * Source-only COBOL procedure parser. This is a bounded control-flow reader,
 * not a compiler: an unrecognized executable construct rejects its program.
 * All token positions stay in the original file's line/column coordinates.
 */
import { CfgNestingDepthError, MAX_CFG_NESTING_DEPTH } from '../../cfg/cfg-builder.js';
import { preprocessCobolSource } from '../../cobol/cobol-preprocessor.js';

export interface CobolToken {
  readonly text: string;
  readonly upper: string;
  readonly line: number;
  readonly column: number;
  readonly kind: 'word' | 'literal' | 'number' | 'punctuation' | 'invalid';
}

export const tokenText = (tokens: readonly CobolToken[]): string =>
  tokens.map((t) => t.text).join(' ');

/** Reuse the ingestion preprocessor; mask indicator/identification areas. */
export function tokenizeCobol(source: string): CobolToken[] {
  const free = />>SOURCE\s+(?:FORMAT\s+(?:IS\s+)?)?FREE/i.test(source.split('\n', 10).join('\n'));
  const lines = preprocessCobolSource(source).split(/\r?\n/);
  const out: CobolToken[] = [];
  for (let row = 0; row < lines.length; row++) {
    const raw = lines[row]!;
    if (free ? /^\s*\*>/.test(raw) : /[*/]/.test(raw[6] ?? '')) continue;
    // Debug lines are conditional compiler input. Split-word/literal continuation
    // requires lexical stitching; reject it instead of inventing new bindings.
    if (!free && /[dD-]/.test(raw[6] ?? '')) {
      out.push({ text: raw, upper: raw.toUpperCase(), line: row + 1, column: 6, kind: 'invalid' });
      continue;
    }
    const code = free ? raw : '       ' + raw.slice(7, 72);
    if (/^\s*>>SOURCE/.test(code)) continue;
    const re = /"(?:""|[^"])*"|'(?:''|[^'])*'|\*>.*|\d+\.\d+|[A-Za-z0-9][A-Za-z0-9_-]*|[^\s]/g;
    for (const m of code.matchAll(re)) {
      const text = m[0];
      if (text.startsWith('*>')) break;
      const kind = /^['"]/.test(text)
        ? text.length > 1 && text.at(-1) === text[0]
          ? 'literal'
          : 'invalid'
        : /[A-Za-z]/.test(text)
          ? 'word'
          : /^\d+(?:\.\d+)?$/.test(text)
            ? 'number'
            : 'punctuation';
      out.push({ text, upper: text.toUpperCase(), line: row + 1, column: m.index!, kind });
    }
  }
  return out;
}

const VERBS = new Set(
  (
    'IF EVALUATE PERFORM MOVE COMPUTE ADD SUBTRACT MULTIPLY DIVIDE SET INITIALIZE ' +
    'DISPLAY ACCEPT CALL CONTINUE EXIT GOBACK STOP GO GOTO ' +
    'ALTER EXEC SEARCH SORT MERGE READ WRITE REWRITE DELETE START OPEN CLOSE ' +
    'STRING UNSTRING INSPECT NEXT CANCEL RELEASE RETURN ENTRY INVOKE ' +
    'DECLARATIVES USE COPY'
  ).split(' '),
);
const SIMPLE = new Set(
  (
    'MOVE COMPUTE ADD SUBTRACT MULTIPLY DIVIDE SET INITIALIZE DISPLAY ACCEPT CALL ' +
    'CONTINUE EXIT GOBACK STOP GO GOTO'
  ).split(' '),
);
const TERMINATORS = new Set(['ELSE', 'WHEN', 'END-IF', 'END-EVALUATE', 'END-PERFORM', '.']);

/** The legacy tagger excludes one-letter names; procedure labels do not. */
export function isCobolParagraphHeading(tokens: readonly CobolToken[]): boolean {
  return (
    tokens.length === 2 &&
    tokens[0]?.kind === 'word' &&
    tokens[1]?.upper === '.' &&
    !VERBS.has(tokens[0]!.upper) &&
    !TERMINATORS.has(tokens[0]!.upper) &&
    !tokens[0]!.upper.startsWith('END-')
  );
}

interface StatementBase {
  readonly tokens: readonly CobolToken[];
}
export type CobolStatement =
  | (StatementBase & { readonly kind: 'simple' })
  | (StatementBase & {
      readonly kind: 'if';
      readonly then: readonly CobolStatement[];
      readonly otherwise: readonly CobolStatement[];
    })
  | (StatementBase & {
      readonly kind: 'evaluate';
      readonly cases: readonly {
        readonly tests: readonly CobolToken[];
        readonly body: readonly CobolStatement[];
        readonly other: boolean;
      }[];
    })
  | (StatementBase & {
      readonly kind: 'perform';
      readonly target?: string;
      readonly thru?: string;
      readonly body: readonly CobolStatement[];
      readonly options: readonly CobolToken[];
    });

export class CobolFlowUnsupported extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'CobolFlowUnsupported';
  }
}

/** Sentence periods close every implicit scope, but only the outer sequence consumes them. */
export class CobolProcedureParser {
  private position = 0;
  private depth = 0;
  constructor(private readonly tokens: readonly CobolToken[]) {}

  parse(): readonly CobolStatement[] {
    const result = this.sequence(new Set(), true);
    if (this.position !== this.tokens.length) this.fail('unexpected scope terminator');
    return result;
  }

  private fail(reason: string): never {
    throw new CobolFlowUnsupported(reason + ' at line ' + (this.tokens[this.position]?.line ?? 0));
  }

  private sequence(stops: ReadonlySet<string>, sentences = false): CobolStatement[] {
    this.depth += 2;
    if (this.depth > MAX_CFG_NESTING_DEPTH) throw new CfgNestingDepthError(MAX_CFG_NESTING_DEPTH);
    try {
      const result: CobolStatement[] = [];
      while (this.position < this.tokens.length) {
        const word = this.tokens[this.position]!.upper;
        if (stops.has(word)) break;
        if (word === '.') {
          if (!sentences) break;
          this.position++;
          continue;
        }
        if (word === 'THEN') {
          this.position++;
          continue;
        }
        result.push(this.statement());
      }
      return result;
    } finally {
      this.depth -= 2;
    }
  }

  private takeHeader(): CobolToken[] {
    const start = this.position++;
    while (this.position < this.tokens.length) {
      const t = this.tokens[this.position]!;
      if (VERBS.has(t.upper) || TERMINATORS.has(t.upper)) break;
      if (t.kind === 'invalid') this.fail('invalid token');
      this.position++;
    }
    return this.tokens.slice(start, this.position);
  }

  private consume(word: string): boolean {
    if (this.tokens[this.position]?.upper !== word) return false;
    this.position++;
    return true;
  }

  private statement(): CobolStatement {
    const verb = this.tokens[this.position]!.upper;
    if (verb === 'IF') {
      const tokens = this.takeHeader();
      if (tokens.length < 2) this.fail('missing IF condition');
      const then = this.sequence(new Set(['ELSE', 'END-IF']));
      const otherwise = this.consume('ELSE') ? this.sequence(new Set(['END-IF'])) : [];
      this.consume('END-IF');
      return { kind: 'if', tokens, then, otherwise };
    }
    if (verb === 'EVALUATE') {
      const tokens = this.takeHeader();
      const cases: { tests: CobolToken[]; body: readonly CobolStatement[]; other: boolean }[] = [];
      while (this.tokens[this.position]?.upper === 'WHEN') {
        const tests: CobolToken[] = [];
        while (this.tokens[this.position]?.upper === 'WHEN')
          tests.push(...this.takeHeader().slice(1));
        const body = this.sequence(new Set(['WHEN', 'END-EVALUATE']));
        cases.push({ tests, body, other: tests.some((t) => t.upper === 'OTHER') });
      }
      if (!cases.length) this.fail('missing EVALUATE cases');
      this.consume('END-EVALUATE');
      return { kind: 'evaluate', tokens, cases };
    }
    if (verb === 'PERFORM') {
      const tokens = this.takeHeader();
      const tail = tokens.slice(1);
      let offset = 0;
      const procedure = (): string => {
        const words = [tail[offset++]!.upper];
        while (['OF', 'IN'].includes(tail[offset]?.upper ?? '')) {
          offset++;
          if (tail[offset]?.kind !== 'word') this.fail('invalid procedure qualification');
          words.push('OF', tail[offset++]!.upper);
        }
        return words.join(' ');
      };
      let target: string | undefined;
      let thru: string | undefined;
      if (
        tail[0]?.kind === 'word' &&
        !['UNTIL', 'VARYING', 'WITH', 'TEST', 'FOREVER'].includes(tail[0]!.upper) &&
        tail[1]?.upper !== 'TIMES'
      ) {
        target = procedure();
        if (['THRU', 'THROUGH'].includes(tail[offset]?.upper ?? '')) {
          offset++;
          if (tail[offset]?.kind !== 'word') this.fail('missing PERFORM THRU target');
          thru = procedure();
        }
      }
      const body = target ? [] : this.sequence(new Set(['END-PERFORM']));
      if (!target && !this.consume('END-PERFORM')) this.fail('missing END-PERFORM');
      return { kind: 'perform', tokens, target, thru, body, options: tail.slice(offset) };
    }
    if (!SIMPLE.has(verb)) this.fail('unsupported ' + verb);
    // PERFORM in EXIT PERFORM is a qualifier, not another statement.
    const start = this.position;
    this.position++;
    if (verb === 'EXIT' && this.tokens[this.position]?.upper === 'PERFORM') this.position++;
    while (this.position < this.tokens.length) {
      const t = this.tokens[this.position]!;
      if (VERBS.has(t.upper) || TERMINATORS.has(t.upper)) break;
      if (t.kind === 'invalid') this.fail('invalid token');
      this.position++;
    }
    const tokens = this.tokens.slice(start, this.position);
    // Exception/size handlers introduce control flow; do not flatten them.
    if (tokens.some((t) => ['EXCEPTION', 'SIZE', 'INVALID', 'OVERFLOW'].includes(t.upper))) {
      this.fail('unsupported conditional statement handler');
    }
    return { kind: 'simple', tokens };
  }
}
