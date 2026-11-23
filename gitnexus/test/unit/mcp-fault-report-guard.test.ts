/**
 * Guard for the fault class of MCP tool errors returned as results.
 *
 * A tool that catches an exception and returns `{ error }` hides the
 * exception from the `tools/call` handler, so the handler cannot read the
 * error's fault mark. Each such handler must state the class itself with
 * `reportCaughtFault(...)` or `reportFault(...)`; otherwise an engine or
 * storage failure would surface as a client fault.
 *
 * A handler is a `catch` block, a `.catch(cb)` callback or the rejection
 * callback of `.then(ok, cb)`. It needs a report when it builds an object
 * literal with an `error` key (returned, or assigned and returned later) or a
 * blocked rename result. The report must start a statement in the same block
 * as that literal, or in an enclosing one, before it: a report in another
 * branch, behind a braceless `if`, or after the `return` does not count.
 *
 * What this scan cannot see, by construction:
 * - `{ error }` results built outside a handler (a validation branch, a
 *   `null` turned into an error later); those sites report explicitly and
 *   have their own tests;
 * - an error object built by a helper called from the handler (other than
 *   the rename result builder), or under a computed key;
 * - whether a report is reached at run time (loops, early `throw`).
 *
 * Structural (source-scanned) rather than behavioural: the sites are spread
 * over dozens of private methods, most only reachable with a failing engine.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { describe, expect, it } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '../../src');
const SCANNED_ROOTS = ['mcp'];

const REGEX_PREFIX_CHARS = '(,=:[!&|?{};+-*%<>~^';
const REGEX_PREFIX_WORDS = new Set(['return', 'typeof', 'case', 'in', 'of', 'void', 'throw']);

/** Blank out comments, string, template and regex literal text, keeping offsets. */
function maskSource(src: string): string {
  let out = '';
  let i = 0;
  const keep = (count = 1) => {
    out += src.slice(i, i + count);
    i += count;
  };
  const blank = (count = 1) => {
    out += src.slice(i, i + count).replace(/[^\n]/g, ' ');
    i += count;
  };
  /** Blank a literal body up to `isEnd`; escapes are blanked as a pair. */
  const blankUntil = (isEnd: () => boolean) => {
    while (i < src.length && !isEnd()) blank(src[i] === '\\' ? 2 : 1);
  };
  while (i < src.length) {
    const c = src[i];
    if (src.startsWith('//', i)) {
      blankUntil(() => src[i] === '\n');
    } else if (src.startsWith('/*', i)) {
      blankUntil(() => src.startsWith('*/', i));
      blank(2);
    } else if (c === "'" || c === '"') {
      keep();
      blankUntil(() => src[i] === c);
      keep();
    } else if (c === '`') {
      keep();
      let depth = 0;
      while (i < src.length && !(depth === 0 && src[i] === '`')) {
        if (src[i] === '\\') blank(2);
        else if (src.startsWith('${', i)) (depth++, keep(2));
        else if (depth > 0 && src[i] === '}') (depth--, keep());
        else if (depth > 0) keep();
        else blank();
      }
      keep();
    } else if (c === '/' && startsRegex(out)) {
      keep();
      let inClass = false;
      blankUntil(() => {
        if (src[i] === '\n' || (!inClass && src[i] === '/')) return true;
        if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        return false;
      });
      keep();
    } else {
      keep();
    }
  }
  return out;
}

function startsRegex(before: string): boolean {
  const trimmed = before.trimEnd();
  if (trimmed === '') return true;
  const word = /[A-Za-z_$]+$/.exec(trimmed)?.[0];
  return (
    REGEX_PREFIX_CHARS.includes(trimmed[trimmed.length - 1]) || REGEX_PREFIX_WORDS.has(word ?? '')
  );
}

/** Index just past the bracket that closes the one at `open`. */
function closeOf(masked: string, open: number): number {
  const pairs: Record<string, string> = { '{': '}', '(': ')', '[': ']' };
  const stack: string[] = [];
  for (let i = open; i < masked.length; i++) {
    const ch = masked[i];
    if (pairs[ch]) stack.push(pairs[ch]);
    else if (ch === stack[stack.length - 1] && stack.pop() !== undefined && stack.length === 0) {
      return i + 1;
    }
  }
  return masked.length;
}

interface Handler {
  at: number;
  start: number;
  end: number;
}

/** Body of a callback argument spanning `[from, to)`: a block, or an expression body. */
function callbackBody(masked: string, from: number, to: number): Handler | undefined {
  const arrow = masked.indexOf('=>', from);
  const fn = /\bfunction\b/.exec(masked.slice(from, to));
  let bodyFrom: number;
  if (arrow !== -1 && arrow < to) bodyFrom = arrow + 2;
  else if (fn) bodyFrom = masked.indexOf(')', from + fn.index) + 1;
  else return undefined;
  while (/\s/.test(masked[bodyFrom] ?? '')) bodyFrom++;
  if (masked[bodyFrom] === '{') {
    return { at: from, start: bodyFrom + 1, end: closeOf(masked, bodyFrom) - 1 };
  }
  return { at: from, start: bodyFrom, end: to };
}

/** Top-level comma positions of the argument list opened at `open`. */
function argumentRanges(masked: string, open: number): Array<[number, number]> {
  const close = closeOf(masked, open) - 1;
  const ranges: Array<[number, number]> = [];
  let from = open + 1;
  for (let i = open + 1; i < close; i++) {
    if ('({['.includes(masked[i])) i = closeOf(masked, i) - 1;
    else if (masked[i] === ',') {
      ranges.push([from, i]);
      from = i + 1;
    }
  }
  ranges.push([from, close]);
  return ranges;
}

/** Every place that runs when an error is caught. */
function handlers(masked: string): Handler[] {
  const found: Handler[] = [];
  for (const m of masked.matchAll(/\bcatch\s*(?:\([^)]*\))?\s*\{/g)) {
    const open = m.index + m[0].length - 1;
    found.push({ at: m.index, start: open + 1, end: closeOf(masked, open) - 1 });
  }
  for (const m of masked.matchAll(/\.(catch|then)\s*\(/g)) {
    const args = argumentRanges(masked, m.index + m[0].length - 1);
    const range = m[1] === 'catch' ? args[0] : args[1];
    const body = range && callbackBody(masked, range[0], range[1]);
    if (body) found.push({ ...body, at: m.index });
  }
  return found.sort((a, b) => a.at - b.at);
}

/** Whether an object literal preceded by `before` is a value: returned, assigned, nested, or an arrow body. */
function isResultLiteral(before: string): boolean {
  if (/\breturn$|=>$|[^=!<>]=$|[:?]$/.test(before)) return true;
  return before.endsWith('(') && before.slice(0, -1).trimEnd().endsWith('=>');
}

/** Offsets in `[start, end)` where an `{ error }` result is built. */
function errorResults(masked: string, start: number, end: number): number[] {
  const body = masked.slice(start, end);
  const offsets: number[] = [];
  for (const m of body.matchAll(/(?:^|[{,\s])(error)\s*[:,}]/g)) {
    const at = m.index + m[0].indexOf('error');
    let depth = 0;
    let open = -1;
    for (let i = at - 1; i >= 0; i--) {
      if (body[i] === '}') depth++;
      else if (body[i] === '{' && depth-- === 0) {
        open = i;
        break;
      }
    }
    // `error` must key an object literal that is returned or stored (or nested in
    // one), not an argument such as a log record or an HTTP error body.
    if (open !== -1 && isResultLiteral(masked.slice(0, start + open).trimEnd())) {
      offsets.push(start + at);
    }
  }
  for (const m of body.matchAll(/\bblocked\(/g)) offsets.push(start + m.index);
  return offsets;
}

/** Unclosed `{` offsets in `[start, at)`: the blocks enclosing `at`. */
function blockPath(masked: string, start: number, at: number): number[] {
  const path: number[] = [];
  for (let i = start; i < at; i++) {
    if (masked[i] === '{') path.push(i);
    else if (masked[i] === '}') path.pop();
  }
  return path;
}

interface CatchSite {
  location: string;
  reports: boolean;
}

/** Handlers that build an `{ error }` result, and whether every such result is reported first. */
function catchToResultSites(file: string, src: string): CatchSite[] {
  const masked = maskSource(src);
  const sites: CatchSite[] = [];
  for (const h of handlers(masked)) {
    const results = errorResults(masked, h.start, h.end);
    if (results.length === 0) continue;
    const reports = [...masked.slice(h.start, h.end).matchAll(/\breport(?:Caught)?Fault\(/g)]
      .map((m) => h.start + m.index)
      .filter((at) => /(^|[;{}])$/.test(masked.slice(h.start, at).trimEnd()));
    const covered = results.every((result) => {
      const resultPath = blockPath(masked, h.start, result);
      return reports.some((report) => {
        if (report > result) return false;
        const reportPath = blockPath(masked, h.start, report);
        return reportPath.every((open, i) => resultPath[i] === open);
      });
    });
    const line = masked.slice(0, h.at).split('\n').length;
    sites.push({ location: `${file}:${line}`, reports: covered });
  }
  return sites;
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return name.endsWith('.ts') && !name.endsWith('.d.ts') ? [full] : [];
  });
}

const scannedSites = (): CatchSite[] =>
  SCANNED_ROOTS.flatMap((root) => sourceFiles(path.join(SRC, root))).flatMap((file) =>
    catchToResultSites(path.relative(SRC, file), readFileSync(file, 'utf8')),
  );

describe('MCP fault report guard', () => {
  it('recognises each handler form and requires a dominating report', () => {
    const src = [
      'async function a() { try { await x(); } catch (err) { return { error: "a" }; } }',
      "async function b() { try { await x(); } catch (err) { reportCaughtFault(err); return { status: 'error', error: msg }; } }",
      'async function c() { try { await x(); } catch { return null; } }',
      'async function d() { try { await x(); } catch (e) { const r = /[/]{/; return { ...blocked(s, n, e) }; } }',
      'async function e() { try { await x(); } catch (e) { return `error: ${e}`; } }',
      'const f = p.catch((e) => ({ error: e.message }));',
      "const g = p.catch((e) => { reportCaughtFault(e); return { error: 'x' }; });",
      'const h = p.then((v) => v, (e) => ({ error: 1 }));',
      "async function i() { let r; try { await x(); } catch (e) { r = { error: 'x' }; } return r; }",
      "async function j() { try { await x(); } catch (e) { if (a) { reportFault('server'); return { error: 1 }; } return { error: 2 }; } }",
      "async function k() { try { await x(); } catch (e) { if (a) reportFault('server'); return { error: 1 }; } }",
      "async function l() { try { await x(); } catch (e) { if (a) { return { error: 1 }; } reportFault('server'); } }",
      'async function m() { try { await x(); } catch (e) { logger.warn({ error: e }); return null; } }',
      "async function n() { try { await x(); } catch (e) { reportCaughtFault(e); return { repo, result: { error: 'x' } }; } }",
    ].join('\n');
    expect(catchToResultSites('fixture.ts', src)).toEqual([
      { location: 'fixture.ts:1', reports: false },
      { location: 'fixture.ts:2', reports: true },
      { location: 'fixture.ts:4', reports: false },
      { location: 'fixture.ts:6', reports: false },
      { location: 'fixture.ts:7', reports: true },
      { location: 'fixture.ts:8', reports: false },
      { location: 'fixture.ts:9', reports: false },
      { location: 'fixture.ts:10', reports: false },
      { location: 'fixture.ts:11', reports: false },
      { location: 'fixture.ts:12', reports: false },
      { location: 'fixture.ts:14', reports: true },
    ]);
  });

  it('finds the known catch-to-result sites', () => {
    const files = new Set(scannedSites().map((site) => site.location.split(':')[0]));
    expect(files).toContain(path.join('mcp', 'local', 'local-backend.ts'));
    expect(files).toContain(path.join('mcp', 'local', 'rename', 'rename-plan.ts'));
    expect(
      scannedSites().filter((site) => site.location.includes('local-backend.ts')).length,
    ).toBeGreaterThanOrEqual(14);
  });

  it('every catch that returns an error result reports its fault class', () => {
    const missing = scannedSites()
      .filter((site) => !site.reports)
      .map((site) => site.location);
    expect(
      missing,
      'Add reportCaughtFault(err) (or reportFault(...)) to these catch blocks',
    ).toEqual([]);
  });
});
