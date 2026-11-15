/** COBOL storage bindings and statement facts for the shared reaching-def solver. */
import type { BindingEntry, StatementFacts, SiteRecord } from '../../cfg/types.js';
import type { CobolRegexResults } from '../../cobol/cobol-preprocessor.js';
import { CobolFlowUnsupported, type CobolToken } from './flow-source.js';

interface DataBinding {
  readonly index: number;
  readonly name: string;
  readonly parents: readonly string[];
  readonly level: number;
  readonly storage?: number;
}
interface Reference {
  readonly bindings: readonly number[];
  readonly indices: readonly number[];
  readonly partial: boolean;
  readonly position: number;
}

const KEYWORDS = new Set(
  (
    'TO FROM BY INTO GIVING REMAINDER ROUNDED IS NOT AND OR EQUAL EQUALS GREATER LESS THAN ' +
    'THEN TRUE FALSE ZERO ZEROS ZEROES SPACE SPACES HIGH-VALUES LOW-VALUES QUOTES NULL NULLS ' +
    'ALL CORRESPONDING CORR OF IN ON UP DOWN WITH NO ADVANCING UPON CONSOLE SYSIN SYSOUT ' +
    'RETURNING USING REFERENCE CONTENT VALUE LENGTH ADDRESS FUNCTION ' +
    'UNTIL VARYING TEST BEFORE AFTER TIMES FOREVER OTHER ALSO WHEN ' +
    'END-CALL END-COMPUTE END-ADD END-SUBTRACT END-MULTIPLY END-DIVIDE END-ACCEPT END-DISPLAY'
  ).split(' '),
);

const unique = (items: readonly number[]): number[] => [...new Set(items)];

export class CobolHarvester {
  readonly bindings: BindingEntry[] = [];
  private readonly declared: DataBinding[] = [];
  private readonly synthetic = new Map<string, number>();

  constructor(
    items: readonly CobolRegexResults['dataItems'][number][],
    private readonly tokens: readonly CobolToken[],
    parameters: readonly string[],
  ) {
    const parents: DataBinding[] = [];
    for (const item of items) {
      if (item.redefines || item.level === 66)
        throw new CobolFlowUnsupported('storage alias declaration');
      while (parents.length && parents.at(-1)!.level >= item.level) parents.pop();
      if ([1, 77].includes(item.level)) parents.length = 0;
      const name = item.name.toUpperCase();
      if (name === 'FILLER') continue;
      const chain = [...parents].reverse().map((p) => p.name);
      const canonical = [name, ...chain].join(' OF ');
      const index = this.bindings.length;
      const formalIndex = parameters.findIndex((p) => p.toUpperCase() === name);
      const declaration = tokens.find((t) => t.line === item.line && t.upper === name);
      this.bindings.push({
        name: canonical,
        declLine: item.line,
        declColumn: declaration?.column ?? 0,
        kind: formalIndex >= 0 ? 'param' : 'var',
        ...(formalIndex >= 0 ? { formalIndex } : {}),
      });
      const binding: DataBinding = {
        index,
        name,
        parents: chain,
        level: item.level,
        ...(item.level === 88 && parents.length ? { storage: parents.at(-1)!.index } : {}),
      };
      this.declared.push(binding);
      if (item.level !== 88) parents.push(binding);
    }
  }

  entryFacts(line: number): StatementFacts {
    return { line, defs: this.bindings.map((_, i) => i), uses: [] };
  }

  private resolve(name: string, qualifiers: readonly string[]): number[] {
    const candidates = this.declared.filter((b) => {
      if (b.name !== name) return false;
      let position = 0;
      for (const q of qualifiers) {
        const found = b.parents.indexOf(q, position);
        if (found < 0) return false;
        position = found + 1;
      }
      return true;
    });
    if (candidates.length > 1) throw new CobolFlowUnsupported('ambiguous data name ' + name);
    const found = candidates[0];
    if (found) {
      if (found.storage !== undefined) return [found.storage];
      // Group operations touch their subordinate storage as well.
      const ancestry = [found.name, ...found.parents];
      const descendants = this.declared.filter(
        (b) =>
          b.index > found.index &&
          b.parents.length >= ancestry.length &&
          ancestry.every((name, i) => b.parents[b.parents.length - ancestry.length + i] === name),
      );
      return unique([
        found.index,
        ...descendants.filter((b) => b.storage === undefined).map((b) => b.index),
      ]);
    }
    const key = [name, ...qualifiers].join(' OF ');
    let index = this.synthetic.get(key);
    if (index === undefined) {
      index = this.bindings.length;
      this.bindings.push({
        name: key,
        declLine: 0,
        declColumn: 0,
        kind: 'module',
        synthetic: true,
      });
      this.synthetic.set(key, index);
    }
    return [index];
  }

  private references(tokens: readonly CobolToken[]): Reference[] {
    const out: Reference[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i]!;
      if (token.kind !== 'word') continue;
      if (KEYWORDS.has(token.upper) && !this.declared.some((b) => b.name === token.upper)) continue;
      const position = i;
      const qualifiers: string[] = [];
      while (['OF', 'IN'].includes(tokens[i + 1]?.upper ?? '') && tokens[i + 2]?.kind === 'word') {
        qualifiers.push(tokens[i + 2]!.upper);
        i += 2;
      }
      const indices: number[] = [];
      let partial = false;
      if (tokens[i + 1]?.upper === '(') {
        partial = true;
        const begin = i + 2;
        let depth = 1;
        i += 2;
        while (i < tokens.length && depth > 0) {
          if (tokens[i]!.upper === '(') depth++;
          if (tokens[i]!.upper === ')') depth--;
          if (depth > 0) i++;
        }
        if (depth) throw new CobolFlowUnsupported('unterminated subscript');
        indices.push(...this.uses(tokens.slice(begin, i)));
      }
      out.push({ bindings: this.resolve(token.upper, qualifiers), indices, partial, position });
    }
    return out;
  }

  uses(tokens: readonly CobolToken[]): number[] {
    return unique(this.references(tokens).flatMap((r) => [...r.bindings, ...r.indices]));
  }

  facts(
    tokens: readonly CobolToken[],
    read: readonly CobolToken[] = [],
    written: readonly CobolToken[] = [],
    readWritten = false,
  ): StatementFacts {
    const defs: number[] = [],
      mayDefs: number[] = [],
      uses = this.uses(read);
    for (const ref of this.references(written)) {
      (ref.partial ? mayDefs : defs).push(...ref.bindings);
      uses.push(...ref.indices, ...(readWritten ? ref.bindings : []));
    }
    return {
      line: tokens[0]!.line,
      defs: unique(defs),
      uses: unique(uses),
      ...(mayDefs.length ? { mayDefs: unique(mayDefs) } : {}),
    };
  }

  statement(tokens: readonly CobolToken[]): StatementFacts {
    const verb = tokens[0]!.upper;
    const rest = tokens.slice(1);
    const at = (word: string) => rest.findIndex((t) => t.upper === word);
    const split = (word: string, readWritten = false) => {
      const n = at(word);
      if (n < 0) throw new CobolFlowUnsupported('missing ' + word + ' in ' + verb);
      return this.facts(tokens, rest.slice(0, n), rest.slice(n + 1), readWritten);
    };
    if (
      ['MOVE', 'INITIALIZE', 'ADD', 'SUBTRACT'].includes(verb) &&
      rest.some((t) => ['CORRESPONDING', 'CORR', 'REPLACING'].includes(t.upper))
    ) {
      throw new CobolFlowUnsupported('group correspondence/replacement');
    }
    switch (verb) {
      case 'MOVE':
        return split('TO');
      case 'COMPUTE': {
        const n = at('=');
        if (n < 0) throw new CobolFlowUnsupported('missing COMPUTE assignment');
        return this.facts(tokens, rest.slice(n + 1), rest.slice(0, n));
      }
      case 'ADD':
      case 'SUBTRACT':
      case 'MULTIPLY':
      case 'DIVIDE': {
        const giving = at('GIVING');
        if (giving >= 0) return this.facts(tokens, rest.slice(0, giving), rest.slice(giving + 1));
        return split(
          verb === 'ADD' ? 'TO' : verb === 'SUBTRACT' ? 'FROM' : verb === 'DIVIDE' ? 'INTO' : 'BY',
          true,
        );
      }
      case 'SET': {
        const to = at('TO');
        if (to >= 0) return this.facts(tokens, rest.slice(to + 1), rest.slice(0, to));
        const direction = rest.findIndex((t) => ['UP', 'DOWN'].includes(t.upper));
        if (direction < 0) throw new CobolFlowUnsupported('unsupported SET');
        return this.facts(tokens, rest.slice(direction + 1), rest.slice(0, direction), true);
      }
      case 'ACCEPT':
        return this.facts(
          tokens,
          at('FROM') < 0 ? [] : rest.slice(at('FROM') + 1),
          at('FROM') < 0 ? rest : rest.slice(0, at('FROM')),
        );
      case 'INITIALIZE':
        return this.facts(tokens, [], rest);
      case 'DISPLAY':
        return this.facts(tokens, rest);
      case 'CALL':
        return this.call(tokens);
      default:
        return this.facts(tokens);
    }
  }

  private call(tokens: readonly CobolToken[]): StatementFacts {
    const target = tokens[1];
    if (!target) throw new CobolFlowUnsupported('missing CALL target');
    const using = tokens.findIndex((t) => t.upper === 'USING');
    const returning = tokens.findIndex((t) => t.upper === 'RETURNING');
    const operands =
      using < 0 ? [] : tokens.slice(using + 1, returning < 0 ? undefined : returning);
    const refs = this.references(operands);
    const uses = target.kind === 'literal' ? [] : this.uses([target]);
    const mayDefs: number[] = [];
    const args: number[][] = [];
    let mode = 'REFERENCE';
    let refIndex = 0;
    // COBOL USING operands are identifiers/literals, each occupying one slot.
    for (let p = 0; p < operands.length; p++) {
      const token = operands[p]!;
      if (token.upper === 'BY') {
        mode = operands[++p]?.upper ?? 'REFERENCE';
        continue;
      }
      const ref = refs[refIndex];
      if (ref?.position === p) {
        args.push(unique([...ref.bindings, ...ref.indices]));
        uses.push(...ref.bindings, ...ref.indices);
        if (mode === 'REFERENCE') mayDefs.push(...ref.bindings);
        refIndex++;
      } else if (['literal', 'number'].includes(token.kind) || token.upper === 'OMITTED') {
        // Numbers inside a subscript do not introduce another CALL argument.
        const prior = refs[refIndex - 1];
        const insideIndex =
          prior?.partial &&
          operands.slice(prior.position, p).filter((t) => t.upper === '(').length >
            operands.slice(prior.position, p).filter((t) => t.upper === ')').length;
        if (!insideIndex) args.push([]);
      }
    }
    const result = this.facts(tokens, [], returning < 0 ? [] : tokens.slice(returning + 1));
    const site: SiteRecord = {
      kind: 'call',
      ...(target.kind === 'literal' ? { callee: target.text.slice(1, -1) } : {}),
      ...(args.length ? { args } : {}),
      ...(result.defs.length ? { resultDefs: result.defs } : {}),
      at: [tokens[0]!.line, tokens[0]!.column],
    };
    return {
      ...result,
      uses: unique([...uses, ...result.uses]),
      ...(mayDefs.length ? { mayDefs: unique([...mayDefs, ...(result.mayDefs ?? [])]) } : {}),
      sites: [site],
    };
  }
}
