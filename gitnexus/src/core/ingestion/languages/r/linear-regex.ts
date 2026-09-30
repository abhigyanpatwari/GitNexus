/**
 * A linear-time matcher for the regular-expression subset that `exportPattern()`
 * arguments use.
 *
 * `exportPattern()` text comes from the repository being analysed and is run against
 * every node name. Compiling it to a JavaScript `RegExp` lets a pattern such as
 * `^(a+)+$` take exponential time on a short name and hang the analyzer, whereas R
 * evaluates the same text with TRE, which does not backtrack. {@link compileLinearRegex}
 * parses the pattern (JavaScript syntax, non-Unicode mode, the dialect `RegExp`
 * accepted before) into a Thompson NFA and simulates it with a set of active states.
 * A match attempt costs O(name length x NFA size) whatever the pattern says, and the
 * total work one matcher may do is capped (see the cost model below).
 *
 * Supported: literals, `.`, bracket expressions, `\d \D \w \W \s \S \b \B`, the
 * single-character escapes, `^ $`, groups (capturing and `(?:)`), alternation and the
 * quantifiers `* + ? {n} {n,} {n,m}` (lazy forms behave identically for a yes/no
 * test). Not supported, and compiled to `null`: back-references and look-around (no
 * linear-time algorithm), named groups, legacy octal escapes, patterns longer than
 * {@link MAX_PATTERN_LENGTH} and patterns whose expansion exceeds {@link MAX_STATES}.
 * A syntax error also yields `null`. Matching is over UTF-16 code units, as
 * `RegExp` without the `u` flag does. {@link compileLinearRegexDetailed} reports why a
 * pattern was refused.
 *
 * Cost model. Compiling is O(pattern length + states). Matching one name is
 * O(name length x active states), and a state count alone does not make a pattern
 * slow: `[[:alpha:]]{1,2000}` has 4,000 states but one of them is active at a time,
 * and an alternation of literals keeps only the ones whose next character matches.
 * What is slow is many active states on a long name, and a repository controls both.
 * So the caps are sized for legitimate patterns and the hostile case is bounded
 * separately, by {@link MAX_TOTAL_WORK}: each matcher counts every state it visits
 * and, once the budget is spent, answers false for names it has not already decided
 * and reports `exhausted`. A visit costs 10-20 ns, so the budget is 0.4-0.8 s per
 * package however many names are tested: measured on the development machine, `a?`
 * repeated 500 or 8,000 times then `c`, `[A-Za-z]{1,2000}c`, and a 120-way alternation
 * of `a...ab` each exhaust it in ~0.4 s against 50,000 distinct 100-character names.
 * Realistic patterns stay far below it: 500 alternated identifiers, anchored or not,
 * cost about 20 visits per name, because alternatives that share a prefix share
 * states. Verdicts are memoised per distinct name, so a repeated name costs one lookup.
 */

/** Longest pattern accepted: room for an alternation of ~1,000 identifiers. */
export const MAX_PATTERN_LENGTH = 16384;

/**
 * Most NFA states a pattern may expand to. Bounded repetition such as `a{1000}` is
 * expanded copy by copy, so this caps memory and compile time; the matching cost is
 * bounded by {@link MAX_TOTAL_WORK}. Room for ~1,000 alternated identifiers of 15
 * characters, or `[[:alpha:]]{1,2000}`.
 */
export const MAX_STATES = 16384;

/** Deepest group nesting accepted; bounds the parser's and the builder's recursion. */
const MAX_NESTING = 2048;

/**
 * Most `build` calls for one pattern. States are capped separately, but a body that
 * creates no states (`(){1000}`) can still be repeated exponentially when nested.
 */
const MAX_BUILD_STEPS = 4 * MAX_STATES;

/**
 * State visits one matcher may spend across all the names it is asked about (see the
 * cost model above).
 */
export const MAX_TOTAL_WORK = 40_000_000;

/** Most distinct names whose verdict a matcher remembers. */
const MAX_MEMO_ENTRIES = 100_000;

/** Thrown internally for unsupported or invalid input; never escapes this module. */
class Reject extends Error {}

const reject = (why: string): never => {
  throw new Reject(why);
};

type Range = readonly [number, number];

interface CharSet {
  readonly ranges: readonly Range[];
  readonly negated: boolean;
}

type Node =
  | { readonly kind: 'empty' }
  | { readonly kind: 'set'; readonly set: CharSet }
  | { readonly kind: 'assert'; readonly which: 'bol' | 'eol' | 'wordb' | 'nwordb' }
  | { readonly kind: 'seq'; readonly items: readonly Node[] }
  | { readonly kind: 'alt'; readonly items: readonly Node[] }
  | { readonly kind: 'repeat'; readonly min: number; readonly max: number; readonly node: Node };

/**
 * The code units of `node` when it matches exactly one fixed string (a literal, or a
 * sequence of literals), else null.
 */
function literalWord(node: Node): number[] | null {
  switch (node.kind) {
    case 'empty':
      return [];
    case 'set': {
      const { ranges, negated } = node.set;
      return !negated && ranges.length === 1 && ranges[0][0] === ranges[0][1]
        ? [ranges[0][0]]
        : null;
    }
    case 'seq': {
      const word: number[] = [];
      for (const item of node.items) {
        const part = literalWord(item);
        if (part === null) return null;
        for (const code of part) word.push(code);
      }
      return word;
    }
    default:
      return null;
  }
}

/** The strings of an alternation whose every alternative is a fixed string, else null. */
function literalWords(items: readonly Node[]): number[][] | null {
  const words: number[][] = [];
  for (const item of items) {
    const word = literalWord(item);
    if (word === null) return null;
    words.push(word);
  }
  return words;
}

const MAX_CODE_UNIT = 0xffff;

const DIGIT: readonly Range[] = [[0x30, 0x39]];
const WORD: readonly Range[] = [
  [0x30, 0x39],
  [0x41, 0x5a],
  [0x5f, 0x5f],
  [0x61, 0x7a],
];
const SPACE: readonly Range[] = [
  [0x09, 0x0d],
  [0x20, 0x20],
  [0xa0, 0xa0],
  [0x1680, 0x1680],
  [0x2000, 0x200a],
  [0x2028, 0x2029],
  [0x202f, 0x202f],
  [0x205f, 0x205f],
  [0x3000, 0x3000],
  [0xfeff, 0xfeff],
];
const LINE_TERMINATORS: readonly Range[] = [
  [0x0a, 0x0a],
  [0x0d, 0x0d],
  [0x2028, 0x2029],
];

/** Complement of a sorted, non-overlapping range list over the UTF-16 code units. */
function complement(ranges: readonly Range[]): Range[] {
  const out: Range[] = [];
  let next = 0;
  for (const [lo, hi] of ranges) {
    if (lo > next) out.push([next, lo - 1]);
    next = hi + 1;
  }
  if (next <= MAX_CODE_UNIT) out.push([next, MAX_CODE_UNIT]);
  return out;
}

const isWordUnit = (c: number): boolean =>
  (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || c === 0x5f || (c >= 0x61 && c <= 0x7a);

const isDecimal = (c: string | undefined): boolean => c !== undefined && c >= '0' && c <= '9';
const isHexDigit = (c: string | undefined): boolean => c !== undefined && /^[0-9A-Fa-f]$/.test(c);
const isAsciiLetter = (c: string | undefined): boolean => c !== undefined && /^[A-Za-z]$/.test(c);

/** What `\x`, `\u` and friends resolve to: a single code unit, or a class. */
type EscapeResult =
  | { readonly code: number }
  | { readonly ranges: readonly Range[]; readonly classEscape: true }
  | { readonly assertion: 'wordb' | 'nwordb' };

/** `{n}`, `{n,}`, `{n,m}` at the sticky cursor. */
const BRACES = /\{(\d+)(?:(,)(\d*))?\}/y;

class Parser {
  private pos = 0;
  private depth = 0;
  /** `\k` is an identity escape only when the pattern has no named group. */
  private readonly hasNamedGroup: boolean;

  constructor(private readonly src: string) {
    this.hasNamedGroup = src.includes('(?<');
  }

  parse(): Node {
    if (this.hasNamedGroup) reject('named groups and look-behind are unsupported');
    const node = this.parseDisjunction();
    if (this.pos < this.src.length) reject('unmatched )');
    return node;
  }

  private peek(offset = 0): string | undefined {
    return this.src[this.pos + offset];
  }

  private parseDisjunction(): Node {
    const alternatives: Node[] = [this.parseAlternative()];
    while (this.peek() === '|') {
      this.pos++;
      alternatives.push(this.parseAlternative());
    }
    return alternatives.length === 1 ? alternatives[0] : { kind: 'alt', items: alternatives };
  }

  private parseAlternative(): Node {
    const items: Node[] = [];
    while (this.pos < this.src.length) {
      const ch = this.peek();
      if (ch === '|' || ch === ')') break;
      items.push(this.parseTerm());
    }
    if (items.length === 0) return { kind: 'empty' };
    return items.length === 1 ? items[0] : { kind: 'seq', items };
  }

  private parseTerm(): Node {
    const ch = this.peek() as string;
    if (ch === '^' || ch === '$') {
      this.pos++;
      this.rejectQuantifierAfterAssertion();
      return { kind: 'assert', which: ch === '^' ? 'bol' : 'eol' };
    }
    const atom = this.parseAtom();
    if (atom.kind === 'assert') {
      this.rejectQuantifierAfterAssertion();
      return atom;
    }
    return this.parseQuantifier(atom);
  }

  private rejectQuantifierAfterAssertion(): void {
    const ch = this.peek();
    if (ch === '*' || ch === '+' || ch === '?') reject('nothing to repeat');
    if (ch === '{' && this.tryReadBraces() !== null) reject('nothing to repeat');
  }

  private parseAtom(): Node {
    const ch = this.peek() as string;
    switch (ch) {
      case '.':
        this.pos++;
        return { kind: 'set', set: { ranges: LINE_TERMINATORS, negated: true } };
      case '(':
        return this.parseGroup();
      case '[':
        return this.parseClass();
      case '\\':
        return this.parseAtomEscape();
      case '*':
      case '+':
      case '?':
        return reject('nothing to repeat');
      case '{':
        if (this.tryReadBraces() !== null) reject('nothing to repeat');
        this.pos++;
        return literal(ch.charCodeAt(0));
      default:
        this.pos++;
        return literal(ch.charCodeAt(0));
    }
  }

  private parseGroup(): Node {
    this.pos++; // (
    if (this.peek() === '?') {
      // `(?:` is a plain group; `(?=`, `(?!`, `(?<` and everything else is unsupported or invalid.
      if (this.peek(1) !== ':') reject('look-around and group modifiers are unsupported');
      this.pos += 2;
    }
    if (++this.depth > MAX_NESTING) reject('groups are nested too deeply');
    const inner = this.parseDisjunction();
    this.depth--;
    if (this.peek() !== ')') reject('unterminated group');
    this.pos++;
    // Wrapped so that `(?:$)*` and `(\b)+` stay quantifiable, unlike a bare assertion.
    return { kind: 'seq', items: [inner] };
  }

  /** Read `{n}`, `{n,}` or `{n,m}` at the cursor without consuming; null when not a quantifier. */
  private tryReadBraces(): { min: number; max: number; length: number } | null {
    BRACES.lastIndex = this.pos;
    const m = BRACES.exec(this.src);
    if (m === null) return null;
    const min = Number(m[1]);
    const max = m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3]);
    return { min, max, length: m[0].length };
  }

  private parseQuantifier(atom: Node): Node {
    const ch = this.peek();
    let min: number;
    let max: number;
    if (ch === '*') {
      min = 0;
      max = Infinity;
      this.pos++;
    } else if (ch === '+') {
      min = 1;
      max = Infinity;
      this.pos++;
    } else if (ch === '?') {
      min = 0;
      max = 1;
      this.pos++;
    } else if (ch === '{') {
      const braces = this.tryReadBraces();
      if (braces === null) return atom; // a literal `{`, parsed as the next atom
      if (braces.max < braces.min) reject('numbers out of order in quantifier');
      min = braces.min;
      max = braces.max;
      this.pos += braces.length;
    } else {
      return atom;
    }
    if (this.peek() === '?') this.pos++; // lazy: irrelevant for a yes/no match
    return { kind: 'repeat', min, max, node: atom };
  }

  /** `\` outside a bracket expression. */
  private parseAtomEscape(): Node {
    const result = this.readEscape(false);
    if ('assertion' in result) return { kind: 'assert', which: result.assertion };
    if ('classEscape' in result) {
      return { kind: 'set', set: { ranges: result.ranges, negated: false } };
    }
    return literal(result.code);
  }

  /**
   * Decode the escape at the cursor (`src[pos] === '\\'`) and advance past it.
   * `inClass` selects the bracket-expression meanings (`\b` is backspace there).
   */
  private readEscape(inClass: boolean): EscapeResult {
    this.pos++; // backslash
    const c = this.peek();
    if (c === undefined) return reject('\\ at end of pattern');
    this.pos++;
    switch (c) {
      case 'd':
        return { ranges: DIGIT, classEscape: true };
      case 'D':
        return { ranges: complement(DIGIT), classEscape: true };
      case 'w':
        return { ranges: WORD, classEscape: true };
      case 'W':
        return { ranges: complement(WORD), classEscape: true };
      case 's':
        return { ranges: SPACE, classEscape: true };
      case 'S':
        return { ranges: complement(SPACE), classEscape: true };
      case 'b':
        return inClass ? { code: 0x08 } : { assertion: 'wordb' };
      case 'B':
        return inClass ? { code: 0x42 } : { assertion: 'nwordb' };
      case 't':
        return { code: 0x09 };
      case 'n':
        return { code: 0x0a };
      case 'v':
        return { code: 0x0b };
      case 'f':
        return { code: 0x0c };
      case 'r':
        return { code: 0x0d };
      case '0':
        if (isDecimal(this.peek())) reject('legacy octal escape');
        return { code: 0 };
      case 'c': {
        const letter = this.peek();
        // Inside a bracket expression Annex B also accepts a digit or `_` after `\c`.
        if (isAsciiLetter(letter) || (inClass && (isDecimal(letter) || letter === '_'))) {
          this.pos++;
          return { code: (letter as string).charCodeAt(0) % 32 };
        }
        // `\c` without a letter is a literal backslash; the `c` is read next.
        this.pos--;
        return { code: 0x5c };
      }
      case 'x': {
        if (isHexDigit(this.peek()) && isHexDigit(this.peek(1))) {
          const code = parseInt(this.src.slice(this.pos, this.pos + 2), 16);
          this.pos += 2;
          return { code };
        }
        return { code: 0x78 };
      }
      case 'u': {
        const digits = this.src.slice(this.pos, this.pos + 4);
        if (/^[0-9A-Fa-f]{4}$/.test(digits)) {
          this.pos += 4;
          return { code: parseInt(digits, 16) };
        }
        return { code: 0x75 };
      }
      case 'k':
        // Identity escape (no named groups exist; `parse` already rejected those).
        return { code: 0x6b };
      default:
        if (c >= '1' && c <= '9') reject('back-reference or legacy octal escape');
        return { code: c.charCodeAt(0) };
    }
  }

  private parseClass(): Node {
    this.pos++; // [
    let negated = false;
    if (this.peek() === '^') {
      negated = true;
      this.pos++;
    }
    const ranges: Range[] = [];
    for (;;) {
      const ch = this.peek();
      if (ch === undefined) reject('unterminated character class');
      if (ch === ']') {
        this.pos++;
        break;
      }
      const lo = this.readClassAtom();
      if (this.peek() === '-' && this.peek(1) !== ']' && this.peek(1) !== undefined) {
        // Possible range: a class escape on either side makes the `-` a literal (Annex B).
        this.pos++; // -
        const hi = this.readClassAtom();
        if ('code' in lo && 'code' in hi) {
          if (lo.code > hi.code) reject('range out of order in character class');
          ranges.push([lo.code, hi.code]);
        } else {
          this.addClassAtom(ranges, lo);
          ranges.push([0x2d, 0x2d]);
          this.addClassAtom(ranges, hi);
        }
      } else {
        this.addClassAtom(ranges, lo);
      }
    }
    return { kind: 'set', set: { ranges: normalise(ranges), negated } };
  }

  private addClassAtom(
    ranges: Range[],
    atom: { readonly code: number } | { readonly ranges: readonly Range[] },
  ): void {
    if ('code' in atom) ranges.push([atom.code, atom.code]);
    else ranges.push(...atom.ranges);
  }

  private readClassAtom(): { readonly code: number } | { readonly ranges: readonly Range[] } {
    const ch = this.peek() as string;
    if (ch !== '\\') {
      this.pos++;
      return { code: ch.charCodeAt(0) };
    }
    const result = this.readEscape(true);
    if ('assertion' in result) return reject('unreachable: no assertions inside a class');
    if ('classEscape' in result) return { ranges: result.ranges };
    return { code: result.code };
  }
}

const literal = (code: number): Node => ({
  kind: 'set',
  set: { ranges: [[code, code]], negated: false },
});

/** Sort and merge overlapping or adjacent ranges. */
function normalise(ranges: readonly Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const out: Array<[number, number]> = [];
  for (const [lo, hi] of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else out.push([lo, hi]);
  }
  return out;
}

// --- NFA ---------------------------------------------------------------------------

const K_CHAR = 0;
const K_SPLIT = 1;
const K_ASSERT = 2;
const K_MATCH = 3;

const A_BOL = 0;
const A_EOL = 1;
const A_WORDB = 2;
const A_NWORDB = 3;

const ASSERT_CODES = { bol: A_BOL, eol: A_EOL, wordb: A_WORDB, nwordb: A_NWORDB } as const;

/** Thompson NFA over parallel arrays; state `i` is described by index `i` of each. */
class Nfa {
  readonly kind: number[] = [];
  readonly out: number[] = [];
  /** Second branch of a split; unused otherwise. */
  readonly out1: number[] = [];
  /** Character set (K_CHAR) or assertion code (K_ASSERT). */
  readonly arg: Array<CharSet | number | null> = [];
  private steps = 0;

  add(kind: number, out: number, out1: number, arg: CharSet | number | null): number {
    if (this.kind.length >= MAX_STATES) reject('pattern expands beyond the state cap');
    this.kind.push(kind);
    this.out.push(out);
    this.out1.push(out1);
    this.arg.push(arg);
    return this.kind.length - 1;
  }

  /** Build `node` so that it continues into `next`; returns its entry state. */
  build(node: Node, next: number): number {
    if (++this.steps > MAX_BUILD_STEPS) reject('pattern expands beyond the work cap');
    switch (node.kind) {
      case 'empty':
        return next;
      case 'set':
        return this.add(K_CHAR, next, -1, node.set);
      case 'assert':
        return this.add(K_ASSERT, next, -1, ASSERT_CODES[node.which]);
      case 'seq': {
        let cont = next;
        for (let i = node.items.length - 1; i >= 0; i--) cont = this.build(node.items[i], cont);
        return cont;
      }
      case 'alt': {
        const words = literalWords(node.items);
        if (words !== null) return this.buildWords(words, next);
        let entry = this.build(node.items[node.items.length - 1], next);
        for (let i = node.items.length - 2; i >= 0; i--) {
          entry = this.add(K_SPLIT, this.build(node.items[i], next), entry, null);
        }
        return entry;
      }
      case 'repeat':
        return this.buildRepeat(node, next);
    }
  }

  /**
   * Build an alternation of literal strings as a trie, so that alternatives sharing a
   * prefix share states (`my_function_0|my_function_1|...` keeps one state active on
   * the common prefix instead of one per alternative). Matches the same strings as the
   * plain alternation. Iterative: a literal may be thousands of characters long.
   */
  private buildWords(words: readonly (readonly number[])[], next: number): number {
    interface TrieNode {
      readonly children: Map<number, TrieNode>;
      terminal: boolean;
    }
    const root: TrieNode = { children: new Map(), terminal: false };
    for (const word of words) {
      let at = root;
      for (const code of word) {
        let child = at.children.get(code);
        if (child === undefined) {
          child = { children: new Map(), terminal: false };
          at.children.set(code, child);
        }
        at = child;
      }
      at.terminal = true;
    }
    // Each entry: a trie node, and the character state whose `out` is that node's entry
    // (-1 for the root, whose entry is the result).
    let rootEntry = next;
    const pending: Array<{ node: TrieNode; via: number }> = [{ node: root, via: -1 }];
    for (let task = pending.pop(); task !== undefined; task = pending.pop()) {
      if (++this.steps > MAX_BUILD_STEPS) reject('pattern expands beyond the work cap');
      const branches: number[] = [];
      if (task.node.terminal) branches.push(next);
      for (const [code, child] of task.node.children) {
        const state = this.add(K_CHAR, -1, -1, {
          ranges: [[code, code]],
          negated: false,
        });
        branches.push(state);
        pending.push({ node: child, via: state });
      }
      let entry = branches[branches.length - 1];
      for (let i = branches.length - 2; i >= 0; i--) {
        entry = this.add(K_SPLIT, branches[i], entry, null);
      }
      if (branches.length === 0) entry = next;
      if (task.via === -1) rootEntry = entry;
      else this.out[task.via] = entry;
    }
    return rootEntry;
  }

  private buildRepeat(node: Extract<Node, { kind: 'repeat' }>, next: number): number {
    // Reject before expanding: a count beyond the cap cannot fit whatever the body is.
    if (node.min > MAX_STATES) reject('repetition count beyond the state cap');
    let cont: number;
    if (node.max === Infinity) {
      const loop = this.add(K_SPLIT, -1, next, null);
      this.out[loop] = this.build(node.node, loop);
      cont = loop;
    } else {
      if (node.max - node.min > MAX_STATES) reject('repetition count beyond the state cap');
      cont = next;
      for (let i = node.min; i < node.max; i++) {
        cont = this.add(K_SPLIT, this.build(node.node, cont), next, null);
      }
    }
    for (let i = 0; i < node.min; i++) cont = this.build(node.node, cont);
    return cont;
  }
}

/** Shared by {@link LinearRegex.startStates} entries that reach the match state. */
const NO_STATES: readonly number[] = [];

/** Empty-transition closure of the start state under one assertion context. */
interface StartClosure {
  /** True when the match state is reachable without consuming a character. */
  readonly matches: boolean;
  /** Character states reachable without consuming a character. */
  readonly chars: readonly number[];
}

/** A compiled pattern. `test` has the same yes/no contract as `RegExp.prototype.test`. */
export class LinearRegex {
  /** Number of NFA states, exposed so tests can assert the structural bound. */
  readonly stateCount: number;
  /** True once the work budget ran out; later unseen names are answered false. */
  exhausted = false;
  /** State visits spent so far, against {@link MAX_TOTAL_WORK}. */
  work = 0;
  private readonly kind: readonly number[];
  private readonly out: readonly number[];
  private readonly out1: readonly number[];
  private readonly arg: ReadonlyArray<CharSet | number | null>;
  private readonly start: number;
  private readonly mark: Int32Array;
  private readonly stack: number[] = [];
  private stamp = 0;
  /** Start closures by assertion context (see {@link contextAt}). */
  private readonly startClosures: Array<StartClosure | undefined> = new Array(16);
  /** Character states of a start closure that accept one code unit, by context and unit. */
  private readonly startStates = new Map<number, readonly number[]>();
  private readonly verdicts = new Map<string, boolean>();

  constructor(
    /** The pattern text this matcher was compiled from (after any POSIX-class translation). */
    readonly source: string,
    nfa: Nfa,
    start: number,
  ) {
    this.kind = nfa.kind;
    this.out = nfa.out;
    this.out1 = nfa.out1;
    this.arg = nfa.arg;
    this.start = start;
    this.stateCount = nfa.kind.length;
    this.mark = new Int32Array(this.stateCount);
  }

  /** True when the pattern matches anywhere in `name` (an unanchored search). */
  test(name: string): boolean {
    const known = this.verdicts.get(name);
    if (known !== undefined) return known;
    if (this.work >= MAX_TOTAL_WORK) {
      this.exhausted = true;
      return false;
    }
    const verdict = this.search(name);
    // A search the budget cut short has no verdict; do not remember it.
    if (!this.exhausted && this.verdicts.size < MAX_MEMO_ENTRIES) this.verdicts.set(name, verdict);
    return verdict;
  }

  private search(name: string): boolean {
    const length = name.length;
    let current: number[] = [];
    let following: number[] = [];
    this.stamp++;
    if (this.seed(current, name, 0)) return true;
    for (let p = 0; p < length; p++) {
      if (this.work > MAX_TOTAL_WORK) {
        this.exhausted = true;
        return false;
      }
      const c = name.charCodeAt(p);
      this.stamp++;
      following.length = 0;
      this.work += current.length;
      for (let i = 0; i < current.length; i++) {
        const s = current[i];
        if (inSet(this.arg[s] as CharSet, c) && this.add(following, this.out[s], name, p + 1)) {
          return true;
        }
      }
      // Unanchored search: a match may also begin at the next position.
      if (this.seed(following, name, p + 1)) return true;
      const swap = current;
      current = following;
      following = swap;
    }
    return false;
  }

  /**
   * Start a match attempt at position `p`: true when the pattern matches there without
   * consuming anything, otherwise the states that can consume `name[p]` are added to
   * `list`. Those are the only start states worth keeping (the rest die on the next
   * step), and looking them up by code unit keeps a long alternation from costing
   * one visit per alternative at every position.
   */
  private seed(list: number[], name: string, p: number): boolean {
    const context = contextAt(name, p);
    const closure = (this.startClosures[context] ??= this.closeStart(context));
    if (closure.matches) return true;
    if (p === name.length) return false;
    const c = name.charCodeAt(p);
    const key = context * 0x10000 + c;
    let states = this.startStates.get(key);
    if (states === undefined) {
      states = closure.chars.filter((s) => inSet(this.arg[s] as CharSet, c));
      if (this.startStates.size < 4096) this.startStates.set(key, states);
    }
    this.work += 1 + states.length;
    for (let i = 0; i < states.length; i++) {
      const s = states[i];
      if (this.mark[s] !== this.stamp) {
        this.mark[s] = this.stamp;
        list.push(s);
      }
    }
    return false;
  }

  /** Closure of the start state where the assertion outcomes are those of `context`. */
  private closeStart(context: number): StartClosure {
    const seen = new Uint8Array(this.stateCount);
    const chars: number[] = [];
    const stack = [this.start];
    while (stack.length > 0) {
      const s = stack.pop() as number;
      if (seen[s] === 1) continue;
      seen[s] = 1;
      switch (this.kind[s]) {
        case K_MATCH:
          return { matches: true, chars: NO_STATES };
        case K_CHAR:
          chars.push(s);
          break;
        case K_SPLIT:
          stack.push(this.out1[s], this.out[s]);
          break;
        default:
          if (holdsIn(this.arg[s] as number, context)) stack.push(this.out[s]);
      }
    }
    return { matches: false, chars };
  }

  /**
   * Follow empty transitions from `state` at position `p`, pushing character states
   * onto `list`. Returns true on reaching the match state. A state is entered at most
   * once per list (the stamp), which also stops empty-loop cycles such as `(a*)*`.
   * Iterative: a long alternation is a long chain of splits.
   */
  private add(list: number[], state: number, name: string, p: number): boolean {
    const stack = this.stack;
    stack.length = 0;
    stack.push(state);
    while (stack.length > 0) {
      const s = stack.pop() as number;
      if (this.mark[s] === this.stamp) continue;
      this.mark[s] = this.stamp;
      this.work++;
      switch (this.kind[s]) {
        case K_MATCH:
          return true;
        case K_CHAR:
          list.push(s);
          break;
        case K_SPLIT:
          stack.push(this.out1[s], this.out[s]);
          break;
        default:
          if (holdsIn(this.arg[s] as number, contextAt(name, p))) stack.push(this.out[s]);
      }
    }
    return false;
  }
}

const CTX_BOL = 1;
const CTX_EOL = 2;
const CTX_WORD_BEFORE = 4;
const CTX_WORD_AFTER = 8;

/** What the assertions can observe at position `p`: the two ends and word-ness either side. */
function contextAt(name: string, p: number): number {
  let context = 0;
  if (p === 0) context |= CTX_BOL;
  else if (isWordUnit(name.charCodeAt(p - 1))) context |= CTX_WORD_BEFORE;
  if (p === name.length) context |= CTX_EOL;
  else if (isWordUnit(name.charCodeAt(p))) context |= CTX_WORD_AFTER;
  return context;
}

function holdsIn(assertion: number, context: number): boolean {
  switch (assertion) {
    case A_BOL:
      return (context & CTX_BOL) !== 0;
    case A_EOL:
      return (context & CTX_EOL) !== 0;
    default: {
      const before = (context & CTX_WORD_BEFORE) !== 0;
      const after = (context & CTX_WORD_AFTER) !== 0;
      return assertion === A_WORDB ? before !== after : before === after;
    }
  }
}

function inSet(set: CharSet, c: number): boolean {
  let hit = false;
  const ranges = set.ranges;
  for (let i = 0; i < ranges.length; i++) {
    const r = ranges[i];
    if (c < r[0]) break; // ranges are sorted
    if (c <= r[1]) {
      hit = true;
      break;
    }
  }
  return hit !== set.negated;
}

/** The outcome of {@link compileLinearRegexDetailed}: a matcher, or why there is none. */
export type LinearRegexResult =
  | { readonly regex: LinearRegex }
  | { readonly regex: null; readonly reason: string };

/**
 * Compile a JavaScript-syntax pattern to a linear-time matcher. When the pattern is
 * invalid, unsupported or too large the result carries the reason instead. Never throws.
 */
export function compileLinearRegexDetailed(source: string): LinearRegexResult {
  if (source.length > MAX_PATTERN_LENGTH) {
    return { regex: null, reason: `pattern is longer than ${MAX_PATTERN_LENGTH} characters` };
  }
  try {
    const ast = new Parser(source).parse();
    const nfa = new Nfa();
    const match = nfa.add(K_MATCH, -1, -1, null);
    const start = nfa.build(ast, match);
    return { regex: new LinearRegex(source, nfa, start) };
  } catch (err) {
    // `Reject` is the expected path; a stack overflow or any other failure also means
    // "cannot match safely", which for an exportPattern is the same as never matching.
    return {
      regex: null,
      reason: err instanceof Reject ? err.message : 'pattern could not be compiled',
    };
  }
}

/** {@link compileLinearRegexDetailed} without the reason: null when there is no matcher. */
export function compileLinearRegex(source: string): LinearRegex | null {
  return compileLinearRegexDetailed(source).regex;
}
