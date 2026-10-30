/**
 * Line-preserving PL/SQL source pre-pass.
 *
 * The grammar recognises SQL and PL/SQL units; real repositories also carry
 * SQL*Plus client commands (`SET`, `DEFINE`, `@@file`, `PROMPT`, `-`
 * continuations, `&` substitution variables) and PL/SQL conditional
 * compilation (`$IF ... $THEN ... $END`). Both are rewritten here so the parser
 * sees only compilable text. Every transformation keeps line breaks — and
 * blanks in place rather than deleting — so ANTLR token positions are the
 * original source positions.
 */

const SQLPLUS_COMMAND =
  /^\s*(?:set|define|def|undefine|undef|prompt|pro|rem|remark|spool|spo|whenever|column|col|connect|conn|accept|acc|pause|show|sho|exit|quit|host|ttitle|btitle|break|compute|clear|var|variable|print|timing|exec|execute|start|sta|disconnect|disc|store|repheader|repfooter|attribute|copy|describe|desc|get|help|list|password|run|save|xquery)\b/i;

/**
 * Statements that start a PL/SQL unit, which only a lone `/` terminates.
 * Tested against a header joined across lines, so `CREATE OR REPLACE` on its
 * own line followed by `PACKAGE BODY …` is still recognised.
 */
const PLSQL_UNIT_START =
  /^(?:create\s+(?:or\s+replace\s+)?(?:(?:non)?editionable\s+)?(?:and\s+(?:compile|resolve)\s+(?:noforce\s+)?java\b|package|procedure|function|trigger|type|library)\b|declare\b|begin\b)/i;

/** A `CREATE` whose object keyword may still be on a following line. */
const CREATE_PREFIX = /^create\b/i;
/** Lines looked ahead to complete a split `CREATE` header. */
const HEADER_LOOKAHEAD_LINES = 6;

const ENDS_STATEMENT = /;\s*(?:--.*)?$/;
const CONTINUATION = /\s-\s*$/;
const LEADING_BLOCK_COMMENTS = /^(?:\/\*[\s\S]*?\*\/\s*)+/;

export interface SqlPlusCommand {
  /** 1-based line of the command's first line. */
  readonly line: number;
  readonly text: string;
}

/** `CREATE` header text joined with the next few code lines (comments skipped). */
function joinedHeader(lines: readonly string[], index: number, first: string): string {
  const parts = [first];
  for (let j = index + 1; j < lines.length && parts.length <= HEADER_LOOKAHEAD_LINES; j++) {
    const t = lines[j]!.replace(/\r$/, '').trim().replace(LEADING_BLOCK_COMMENTS, '');
    if (t === '' || t.startsWith('--')) continue;
    parts.push(t);
  }
  return parts.join(' ');
}

/**
 * Blank SQL*Plus commands. They are only recognised *between* statements:
 * inside a PL/SQL unit `EXECUTE IMMEDIATE ...`, `EXIT WHEN …` or a call to a
 * procedure named `run` is ordinary code and must survive.
 */
export function stripSqlPlusCommands(source: string, commands?: SqlPlusCommand[]): string {
  const lines = source.split('\n');
  let state: 'between' | 'plsql' | 'sql' = 'between';
  let continuation = false;
  let inBlockComment = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const trimmed = line.replace(/\r$/, '').trim();
    if (continuation) {
      continuation = CONTINUATION.test(trimmed);
      lines[i] = blankLine(line);
      continue;
    }
    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false;
      continue;
    }
    if (state === 'plsql') {
      if (trimmed === '/') state = 'between';
      continue;
    }
    if (state === 'sql') {
      if (trimmed === '/' || ENDS_STATEMENT.test(trimmed)) state = 'between';
      continue;
    }
    // Code after any leading `/* … */` on the same line.
    const code = trimmed.replace(LEADING_BLOCK_COMMENTS, '');
    if (code.startsWith('/*')) {
      inBlockComment = true;
      continue;
    }
    if (code === '' || code.startsWith('--') || code === '/') continue;
    if (code === trimmed && (SQLPLUS_COMMAND.test(code) || code.startsWith('@'))) {
      continuation = CONTINUATION.test(code);
      commands?.push({ line: i + 1, text: line.replace(/\r$/, '') });
      lines[i] = blankLine(line);
      continue;
    }
    const header = CREATE_PREFIX.test(code) ? joinedHeader(lines, i, code) : code;
    if (PLSQL_UNIT_START.test(header)) state = 'plsql';
    else if (!ENDS_STATEMENT.test(code)) state = 'sql';
  }
  return lines.join('\n');
}

function blankLine(line: string): string {
  return line.endsWith('\r') ? '\r' : '';
}

/**
 * `&name` / `&&name` / `&name.` → an identifier of exactly the same length
 * (`Zname`, `ZZname`), so token columns stay aligned with the original text.
 */
export function neutraliseSubstitutionVariables(source: string): string {
  return source.replace(
    /(&&?)([A-Za-z_][\w$#]*)(\.?)/g,
    (_m, amps: string, name: string, dot: string) =>
      `${'Z'.repeat(amps.length)}${name}${dot ? ' ' : ''}`,
  );
}

type CcFrame = { mode: 'condition' | 'kept' | 'skipped' | 'error'; taken: boolean };

const CC_DIRECTIVE = /^\$(if|then|elsif|else|end|error)\b/i;

/**
 * Resolve conditional compilation by keeping the first selected branch of
 * every `$IF` (the condition is not evaluated) and blanking directives, the
 * conditions and all other branches. Nesting-aware; strings, quoted
 * identifiers and comments are skipped so `$end` inside a literal is ignored.
 */
export function resolveConditionalCompilation(source: string): string {
  if (!/\$(?:if|error)\b/i.test(source)) return source;
  const out: string[] = [];
  const stack: CcFrame[] = [];
  const blanking = () => stack.some((f) => f.mode !== 'kept');
  const emit = (text: string) => {
    out.push(blanking() ? text.replace(/[^\r\n]/g, ' ') : text);
  };
  const emitBlank = (text: string) => out.push(text.replace(/[^\r\n]/g, ' '));

  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    // -- line comment
    if (ch === '-' && next === '-') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      emit(source.slice(i, stop));
      i = stop;
      continue;
    }
    // /* block comment */
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      emit(source.slice(i, stop));
      i = stop;
      continue;
    }
    // q'[...]' alternative quoting
    if (
      (ch === 'q' || ch === 'Q') &&
      next === "'" &&
      i + 2 < source.length &&
      !isWordChar(source[i - 1])
    ) {
      const open = source[i + 2]!;
      const close = { '[': ']', '(': ')', '{': '}', '<': '>' }[open] ?? open;
      const end = source.indexOf(`${close}'`, i + 3);
      const stop = end === -1 ? source.length : end + 2;
      emit(source.slice(i, stop));
      i = stop;
      continue;
    }
    // '...' string with '' escapes
    if (ch === "'") {
      let j = i + 1;
      while (j < source.length) {
        if (source[j] === "'") {
          if (source[j + 1] === "'") j += 2;
          else break;
        } else j++;
      }
      const stop = Math.min(j + 1, source.length);
      emit(source.slice(i, stop));
      i = stop;
      continue;
    }
    // "quoted identifier"
    if (ch === '"') {
      const end = source.indexOf('"', i + 1);
      const stop = end === -1 ? source.length : end + 1;
      emit(source.slice(i, stop));
      i = stop;
      continue;
    }
    if (ch === '$' && next !== '$' && !isWordChar(source[i - 1])) {
      const m = CC_DIRECTIVE.exec(source.slice(i, i + 8));
      if (m) {
        const directive = m[1]!.toLowerCase();
        const top = stack[stack.length - 1];
        switch (directive) {
          case 'if':
            stack.push({ mode: 'condition', taken: false });
            break;
          case 'error':
            stack.push({ mode: 'error', taken: false });
            break;
          case 'then':
            if (top?.mode === 'condition') {
              top.mode = top.taken ? 'skipped' : 'kept';
              top.taken = true;
            }
            break;
          case 'elsif':
            if (top && top.mode !== 'error') top.mode = 'condition';
            break;
          case 'else':
            if (top && top.mode !== 'error') {
              top.mode = top.taken ? 'skipped' : 'kept';
              top.taken = true;
            }
            break;
          case 'end':
            emitBlank(m[0]);
            stack.pop();
            i += m[0].length;
            continue;
        }
        emitBlank(m[0]);
        i += m[0].length;
        continue;
      }
    }
    emit(ch);
    i++;
  }
  return out.join('');
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[\w$#]/.test(ch);
}

/** Full pre-pass in the order the constructs nest. */
export function preprocessPlSql(source: string, commands?: SqlPlusCommand[]): string {
  return resolveConditionalCompilation(
    neutraliseSubstitutionVariables(stripSqlPlusCommands(source, commands)),
  );
}

export interface ScriptInclude {
  readonly line: number;
  /** 0-based column of the path text. */
  readonly column: number;
  /** Path as written (`pkg_loan.pks`, `../common/setup`). */
  readonly target: string;
  /** `@@` resolves against the calling script's directory; `@`/`START` against the working directory. */
  readonly relativeToScript: boolean;
}

const INCLUDE_COMMAND = /^(\s*)(@@|@|sta(?:rt)?\s+)("[^"]+"|\S+)/i;

/** SQL*Plus script inclusion (`@@file`, `@file`, `START file`) among blanked commands. */
export function scriptIncludesOf(commands: readonly SqlPlusCommand[]): ScriptInclude[] {
  const out: ScriptInclude[] = [];
  for (const command of commands) {
    const m = INCLUDE_COMMAND.exec(command.text);
    if (!m) continue;
    const raw = m[3]!;
    const target = raw.startsWith('"') ? raw.slice(1, -1) : raw;
    // Substitution-variable paths (`@&dir/x.sql`) cannot be resolved statically.
    if (target.includes('&')) continue;
    out.push({
      line: command.line,
      column: m[1]!.length + m[2]!.length + (raw.startsWith('"') ? 1 : 0),
      target,
      relativeToScript: m[2] === '@@',
    });
  }
  return out;
}
