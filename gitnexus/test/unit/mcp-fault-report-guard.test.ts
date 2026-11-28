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
 *   the rename result builder), under a computed key, or under a quoted key
 *   (`{ "error": … }`: string contents are masked);
 * - a literal that is an operand of `||`/`&&`, an array element, a `yield`
 *   operand or a call argument (a call argument is excluded on purpose, so
 *   log records and HTTP error bodies are not counted), except the argument of
 *   a returned `Promise.resolve(…)` or `resolve(…)`; a literal passed through
 *   any other helper, `Promise.reject(…)` or a stored promise is not seen;
 * - a named callback (`p.catch(toError)`) or a call with type arguments
 *   (`p.then<A, B>(ok, onError)`);
 * - whether a report is reached at run time (loops, early `throw`).
 * The per-file site counts below are pinned, but they count only the sites
 * this scan recognises: they notice a recognised handler added or removed,
 * not a handler written in one of the forms above.
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
// Group mode (`repo: "@group"`, group_* tools) is on the tools/call path too.
const SCANNED_ROOTS = ['mcp', path.join('core', 'group')];

const REGEX_PREFIX_CHARS = '(,=:[!&|?{};+-*%<>~^';
const REGEX_PREFIX_WORDS = new Set([
  'return',
  'typeof',
  'case',
  'in',
  'of',
  'void',
  'throw',
  'await',
  'yield',
]);

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
  /** Mask code to the end, or inside `${…}` to the brace that closes it. */
  const code = (interpolation: boolean) => {
    let braces = 0;
    while (i < src.length) {
      const c = src[i];
      if (interpolation && c === '}' && braces === 0) return;
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
        template();
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
        if (c === '{') braces++;
        else if (c === '}') braces--;
        keep();
      }
    }
  };
  /** Blank a template's text; each `${…}` is code, masked like any other. */
  const template = () => {
    keep();
    while (i < src.length && src[i] !== '`') {
      if (src[i] === '\\') blank(2);
      else if (src.startsWith('${', i)) {
        keep(2);
        code(true);
        keep();
      } else blank();
    }
    keep();
  };
  code(false);
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
  // A parenthesised literal, `return ({ error })` or an arrow body `=> ({ error })`,
  // and a literal resolved as the result: `return Promise.resolve({ error })`.
  return (
    before.endsWith('(') &&
    /(\breturn|=>)\s*(?:(?:Promise\.)?resolve)?$/.test(before.slice(0, -1).trimEnd())
  );
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
      "async function o() { try { await x(); } catch (e) { log('x; reportFault(1)'); return { error: 1 }; } }",
      "async function q() { try { await x(); } catch (e) {\n // done; reportFault('server');\n return { error: 1 }; } }",
      'async function r() { try { await x(); } catch (e) { return ({ error: 1 }); } }',
      "async function s() { try { await x(); } catch (e) { reportFault('server'); return ({ error: 1 }); } }",
      'async function t() { try { await x(); } catch (e) { return Promise.resolve({ error: 1 }); } }',
      'async function u() { try { await x(); } catch (e) { reportCaughtFault(e); return Promise.resolve({ error: 1 }); } }',
      'const v = new Promise((resolve) => { try { x(); } catch (e) { return resolve({ error: 1 }); } });',
      // Interpolations are code: a block or a quoted brace inside one does not end it.
      'const w = `${invoke({ x: 1 }, () => { try { f(); } catch (e) { return { error: e }; } })}`;',
      "const y = `${g('}') + p.catch((e) => ({ error: e }))}`;",
      // A regex after `await` is masked, so a report spelled inside it does not count.
      'async function z() { try { await x(); } catch (e) { await /;reportFault(.*)/.test(s); return { error: e }; } }',
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
      // A report inside a string or a comment is not a report.
      { location: 'fixture.ts:15', reports: false },
      { location: 'fixture.ts:16', reports: false },
      { location: 'fixture.ts:19', reports: false },
      { location: 'fixture.ts:20', reports: true },
      { location: 'fixture.ts:21', reports: false },
      { location: 'fixture.ts:22', reports: true },
      { location: 'fixture.ts:23', reports: false },
      { location: 'fixture.ts:24', reports: false },
      { location: 'fixture.ts:25', reports: false },
      { location: 'fixture.ts:26', reports: false },
    ]);
  });

  it('finds the known catch-to-result sites in every scanned file', () => {
    const counts: Record<string, number> = {};
    for (const site of scannedSites()) {
      const file = site.location.split(':')[0].split(path.sep).join('/');
      counts[file] = (counts[file] ?? 0) + 1;
    }
    expect(counts, 'A handler was added or removed: review it, then update these counts').toEqual({
      'core/group/cross-impact.ts': 4,
      'core/group/cross-trace.ts': 1,
      'core/group/resolve-at-member.ts': 1,
      'core/group/service.ts': 9,
      'mcp/local/local-backend.ts': 14,
      'mcp/local/pdg-impact.ts': 1,
      'mcp/local/rename/rename-plan.ts': 3,
    });
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
