/**
 * Jupyter notebook (.ipynb) Python extractor.
 *
 * Pulls code-cell source from nbformat JSON so the Python tree-sitter
 * grammar can parse it. Extraction helpers are I/O-free and worker-safe.
 * `extractNotebookPythonCached` is an optional process-local LRU for FTS.
 *
 * Graph coordinates stay 0-based lines in the on-disk JSON file. Extract
 * buffer lines map through {@link mapExtractLine}.
 */

import { isNotebookFilename } from 'gitnexus-shared';
import { buildLineIndex, lineFromOffset } from '../embeddings/line-index.js';

export interface NotebookLineSegment {
  readonly extractStartLine: number;
  readonly extractEndLine: number;
  readonly jsonStartLine: number;
  readonly jsonEndLine: number;
}

export interface NotebookPythonExtraction {
  readonly pythonSource: string;
  readonly segments: readonly NotebookLineSegment[];
}

const PYTHON_FAMILY = new Set([
  'python',
  'python2',
  'python3',
  'ipython',
  'sage',
  'sagemath',
  'micropython',
  'pyodide',
  'pypy',
  'pyspark',
]);

export function isNotebookPath(filePath: string): boolean {
  return isNotebookFilename(filePath);
}

export function isPythonFamilyLanguage(name: string | undefined | null): boolean {
  if (name === undefined || name === null) return false;
  const n = name.trim().toLowerCase();
  if (PYTHON_FAMILY.has(n)) return true;
  if (n.startsWith('ipython')) return true;
  return /^python(?:\d|\b)/.test(n);
}

/** Kernel spec names that are a language id, not a conda env label. */
const NON_PYTHON_KERNEL =
  /^(?:julia|ir|r|scala|rust|ruby|javascript|nodejs|node|bash|sh|sql|csharp|fsharp|go|java|kotlin|swift|php|perl|lua|octave|matlab|sas|stata|haskell|clojure|elixir|groovy|powershell|sos|cpp|cxx|dart|typescript|wolfram|scheme|racket|ocaml|fortran|gnuplot|sqlite|mysql|postgresql|tsql)(?:[-_][\w.-]+|\d[\w.-]*)?$/i;

function kernelNameLanguage(name: string): string | undefined {
  if (isPythonFamilyLanguage(name) || NON_PYTHON_KERNEL.test(name.trim())) return name;
  return undefined;
}

function extensionLanguage(ext: string): string | undefined {
  const e = ext.trim().toLowerCase();
  if (e === '.py' || e === '.pyi' || e === '.ipy') return 'python';
  if (
    e === '.r' ||
    e === '.jl' ||
    e === '.scala' ||
    e === '.js' ||
    e === '.java' ||
    e === '.go' ||
    e === '.rs' ||
    e === '.rb' ||
    e === '.php' ||
    e === '.kt' ||
    e === '.swift' ||
    e === '.cs'
  ) {
    return ext;
  }
  return undefined;
}

function skipWs(content: string, i: number): number {
  while (i < content.length) {
    const c = content.charCodeAt(i);
    if (c === 32 || c === 9 || c === 10 || c === 13) i++;
    else break;
  }
  return i;
}

/** Span of a JSON string or array value starting at the first `"` or `[`. */
function jsonValueSpan(content: string, start: number): { start: number; end: number } | null {
  const i = skipWs(content, start);
  if (i >= content.length) return null;
  if (content[i] === '"') {
    let j = i + 1;
    while (j < content.length) {
      if (content[j] === '\\') {
        j += 2;
        continue;
      }
      if (content[j] === '"') return { start: i, end: j + 1 };
      j++;
    }
    return null;
  }
  if (content[i] === '[') {
    let depth = 1;
    let j = i + 1;
    let inStr = false;
    while (j < content.length && depth > 0) {
      const ch = content[j];
      if (inStr) {
        if (ch === '\\') j += 2;
        else {
          if (ch === '"') inStr = false;
          j++;
        }
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === '[') depth++;
      else if (ch === ']') depth--;
      j++;
    }
    return { start: i, end: j };
  }
  return null;
}

function jsonBraceSpan(
  content: string,
  start: number,
  open: '{' | '[',
  close: '}' | ']',
): { start: number; end: number } | null {
  const i = skipWs(content, start);
  if (i >= content.length || content[i] !== open) return null;
  let depth = 1;
  let j = i + 1;
  let inStr = false;
  while (j < content.length && depth > 0) {
    const ch = content[j];
    if (inStr) {
      if (ch === '\\') j += 2;
      else {
        if (ch === '"') inStr = false;
        j++;
      }
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === open) depth++;
    else if (ch === close) depth--;
    j++;
  }
  if (depth !== 0) return null;
  return { start: i, end: j };
}

function findDepth1Key(
  content: string,
  objStart: number,
  objEnd: number,
  key: string,
  match: 'first' | 'last' = 'first',
): number {
  let depth = 0;
  let inStr = false;
  let j = objStart;
  let found = -1;
  while (j < objEnd) {
    const ch = content[j];
    if (inStr) {
      if (ch === '\\') j += 2;
      else {
        if (ch === '"') inStr = false;
        j++;
      }
      continue;
    }
    if (ch === '"') {
      if (depth === 1 && content.startsWith(key, j)) {
        if (match === 'first') return j;
        found = j;
      }
      inStr = true;
      j++;
      continue;
    }
    if (ch === '{' || ch === '[') depth++;
    else if (ch === '}' || ch === ']') depth--;
    j++;
  }
  return found;
}

function arraySpanAfterKey(
  content: string,
  objStart: number,
  objEnd: number,
  key: '"cells"' | '"worksheets"',
  match: 'first' | 'last',
): { start: number; end: number } | null {
  const keyAt = findDepth1Key(content, objStart, objEnd, key, match);
  if (keyAt < 0) return null;
  const colon = content.indexOf(':', keyAt + key.length);
  if (colon < 0 || colon >= objEnd) return null;
  return jsonBraceSpan(content, colon + 1, '[', ']');
}

function codeCellArraySpans(content: string, origin: number): { start: number; end: number }[] {
  const root = jsonBraceSpan(content, origin, '{', '}');
  if (!root) return [];
  const cells = arraySpanAfterKey(content, root.start, root.end, '"cells"', 'last');
  if (cells) return [cells];
  const worksheets = arraySpanAfterKey(content, root.start, root.end, '"worksheets"', 'last');
  if (!worksheets) return [];
  const spans: { start: number; end: number }[] = [];
  let search = worksheets.start + 1;
  while (search < worksheets.end) {
    const brace = nextUnquotedChar(content, search, worksheets.end, '{');
    if (brace < 0) break;
    const obj = jsonBraceSpan(content, brace, '{', '}');
    if (!obj || obj.end > worksheets.end) {
      search = brace + 1;
      continue;
    }
    const nested = arraySpanAfterKey(content, obj.start, obj.end, '"cells"', 'first');
    if (nested) spans.push(nested);
    search = obj.end;
  }
  return spans;
}

function readJsonString(content: string, start: number): string | null {
  const i = skipWs(content, start);
  if (content[i] !== '"') return null;
  let j = i + 1;
  let out = '';
  while (j < content.length) {
    const ch = content[j];
    if (ch === '\\') {
      out += content[j + 1] ?? '';
      j += 2;
      continue;
    }
    if (ch === '"') return out;
    out += ch;
    j++;
  }
  return null;
}

function nextUnquotedChar(content: string, from: number, until: number, needle: '{' | '"'): number {
  let inStr = false;
  let j = from;
  while (j < until) {
    const ch = content[j];
    if (inStr) {
      if (ch === '\\') j += 2;
      else {
        if (ch === '"') inStr = false;
        j++;
      }
      continue;
    }
    if (ch === '"') {
      if (needle === '"') return j;
      inStr = true;
      j++;
      continue;
    }
    if (ch === needle) return j;
    j++;
  }
  return -1;
}

function firstQuoteInValue(content: string, span: { start: number; end: number }): number {
  const i = skipWs(content, span.start);
  if (i < span.end && content[i] === '"') return i;
  if (i < span.end && content[i] === '[') {
    const q = nextUnquotedChar(content, i + 1, span.end, '"');
    if (q >= 0) return q;
  }
  return span.start;
}

function findNextCodeCellSourceSpan(
  content: string,
  from: number,
  cells: { start: number; end: number },
): { span: { start: number; end: number } | null; nextFrom: number } | null {
  let search = Math.max(from, cells.start + 1);
  while (search < cells.end) {
    const brace = nextUnquotedChar(content, search, cells.end, '{');
    if (brace < 0) return null;
    const obj = jsonBraceSpan(content, brace, '{', '}');
    if (!obj || obj.end > cells.end) {
      search = brace + 1;
      continue;
    }
    const typeKey = findDepth1Key(content, obj.start, obj.end, '"cell_type"');
    if (typeKey < 0) {
      search = obj.end;
      continue;
    }
    const colon = content.indexOf(':', typeKey + 11);
    if (colon < 0 || colon >= obj.end) {
      search = obj.end;
      continue;
    }
    const valueStart = skipWs(content, colon + 1);
    const cellType = readJsonString(content, valueStart);
    if (cellType === null || cellType.toLowerCase() !== 'code') {
      search = obj.end;
      continue;
    }
    let sourceKey = findDepth1Key(content, obj.start, obj.end, '"source"');
    let keyLen = 8;
    if (sourceKey < 0) {
      sourceKey = findDepth1Key(content, obj.start, obj.end, '"input"');
      keyLen = 7;
    }
    if (sourceKey < 0) {
      return { span: null, nextFrom: obj.end };
    }
    const srcColon = content.indexOf(':', sourceKey + keyLen);
    if (srcColon < 0 || srcColon >= obj.end) {
      return { span: null, nextFrom: obj.end };
    }
    const span = jsonValueSpan(content, srcColon + 1);
    if (!span) {
      return { span: null, nextFrom: obj.end };
    }
    return { span, nextFrom: obj.end };
  }
  return null;
}

function flattenSource(source: unknown): string {
  if (typeof source === 'string') return source;
  if (Array.isArray(source)) {
    return source.map((part) => (typeof part === 'string' ? part : '')).join('');
  }
  return '';
}

function cellLanguage(cell: Record<string, unknown>): string | undefined {
  if (typeof cell.language === 'string') return cell.language;
  const meta = cell.metadata;
  if (!meta || typeof meta !== 'object') return undefined;
  const m = meta as Record<string, unknown>;
  if (typeof m.language === 'string') return m.language;
  const vscode = m.vscode;
  if (vscode && typeof vscode === 'object') {
    const langId = (vscode as Record<string, unknown>).languageId;
    if (typeof langId === 'string') return langId;
  }
  return undefined;
}

function notebookLanguageFields(nb: Record<string, unknown>): {
  kernelspec?: string;
  languageInfo?: string;
} {
  const metadata = nb.metadata;
  if (!metadata || typeof metadata !== 'object') return {};
  const md = metadata as Record<string, unknown>;
  const ks = md.kernelspec;
  const li = md.language_info;
  return {
    kernelspec:
      ks && typeof ks === 'object'
        ? typeof (ks as Record<string, unknown>).language === 'string'
          ? String((ks as Record<string, unknown>).language)
          : kernelNameLanguage(String((ks as Record<string, unknown>).name ?? ''))
        : undefined,
    languageInfo:
      li && typeof li === 'object'
        ? typeof (li as Record<string, unknown>).name === 'string'
          ? String((li as Record<string, unknown>).name)
          : extensionLanguage(String((li as Record<string, unknown>).file_extension ?? ''))
        : undefined,
  };
}

function kernelShouldSkip(nb: Record<string, unknown>): boolean {
  const { kernelspec, languageInfo } = notebookLanguageFields(nb);
  const fields = [kernelspec, languageInfo].filter((x): x is string => x !== undefined);
  if (fields.length === 0) return false;
  return fields.some((f) => !isPythonFamilyLanguage(f));
}

/** Cell magics whose body is still Python. Foreign %% cells are skipped. */
const PYTHON_CELL_MAGICS = new Set([
  'time',
  'timeit',
  'capture',
  'prun',
  'lprun',
  'mprun',
  'debug',
  'px',
  'python',
  'python2',
  'python3',
  'ipython',
  'pypy',
]);

function cellMagicName(line: string): string {
  const token = line.trimStart().slice(2).trim().split(/\s+/)[0] ?? '';
  return token.toLowerCase();
}

function isIpythonHelpLine(line: string): boolean {
  const t = line.trim();
  if (t.length === 0 || t.startsWith('#')) return false;
  return /^\?\??\S/.test(t) || /^[A-Za-z_][\w.]*(?:\?\?|\?)\s*$/.test(t);
}

function moduleSpecFromRunPath(raw: string): string | null {
  let path = raw
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/\\/g, '/');
  if (path.startsWith('http://') || path.startsWith('https://') || path.endsWith('.ipynb')) {
    return null;
  }
  path = path.replace(/^\.\//, '');
  if (path.endsWith('.py')) path = path.slice(0, -3);
  const parts = path.split('/').filter((part) => part.length > 0);
  if (parts.length === 0 || parts.some((part) => part === '..' || !/^[A-Za-z_]\w*$/.test(part))) {
    return null;
  }
  return parts.join('.');
}

function rewriteRunOrLoad(line: string): string | null {
  const trimmed = line.trimStart();
  const indent = line.slice(0, line.length - trimmed.length);
  const match = trimmed.match(/^%(?:run|load|loadpy)\s+(\S+)/);
  if (!match) return null;
  const spec = moduleSpecFromRunPath(match[1]);
  if (!spec) return null;
  return `${indent}import ${spec}  # ${trimmed}`;
}

function isBalancedPython(source: string): boolean {
  let quote: "'" | '"' | null = null;
  let triple = false;
  let paren = 0;
  let bracket = 0;
  let brace = 0;
  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (quote) {
      if (ch === '\\' && !triple) {
        i++;
        continue;
      }
      if (triple && source.startsWith(quote.repeat(3), i)) {
        quote = null;
        triple = false;
        i += 2;
        continue;
      }
      if (!triple && ch === quote) quote = null;
      continue;
    }
    if (ch === '#') {
      const nl = source.indexOf('\n', i);
      if (nl < 0) break;
      i = nl;
      continue;
    }
    if ((ch === '"' || ch === "'") && source.startsWith(ch.repeat(3), i)) {
      quote = ch;
      triple = true;
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '(') paren++;
    else if (ch === ')') paren--;
    else if (ch === '[') bracket++;
    else if (ch === ']') bracket--;
    else if (ch === '{') brace++;
    else if (ch === '}') brace--;
    if (paren < 0 || bracket < 0 || brace < 0) return false;
  }
  return quote === null && paren === 0 && bracket === 0 && brace === 0;
}

function processCellLines(raw: string): { skipCell: boolean; lines: string[] } {
  const lines = raw.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const firstNonEmpty = lines.find((l) => l.trim().length > 0);
  const magic =
    firstNonEmpty !== undefined && firstNonEmpty.trimStart().startsWith('%%')
      ? cellMagicName(firstNonEmpty)
      : undefined;
  if (magic !== undefined && !PYTHON_CELL_MAGICS.has(magic) && !isPythonFamilyLanguage(magic)) {
    return { skipCell: true, lines: [''] };
  }
  const rewritten = lines.map((line) => {
    const t = line.trimStart();
    if (isIpythonHelpLine(line) || t.startsWith('!')) return `# ${line}`;
    const runImport = rewriteRunOrLoad(line);
    if (runImport) return runImport;
    if (t.startsWith('%')) return `# ${line}`;
    return line;
  });
  if (isBalancedPython(rewritten.join('\n'))) {
    return { skipCell: false, lines: rewritten };
  }
  return {
    skipCell: false,
    lines: rewritten.map((line) => (line.trim().length === 0 ? line : `# ${line}`)),
  };
}

function notebookCodeCells(nb: Record<string, unknown>): unknown[] | null {
  if (Array.isArray(nb.cells)) return nb.cells;
  if (!Array.isArray(nb.worksheets)) return null;
  const cells: unknown[] = [];
  for (const worksheet of nb.worksheets) {
    if (!worksheet || typeof worksheet !== 'object') continue;
    const nested = (worksheet as Record<string, unknown>).cells;
    if (Array.isArray(nested)) cells.push(...nested);
  }
  return cells.length > 0 ? cells : null;
}

function cellSource(cell: Record<string, unknown>): unknown {
  return cell.source !== undefined ? cell.source : cell.input;
}

export function extractNotebookPython(content: string): NotebookPythonExtraction | null {
  const origin = content.charCodeAt(0) === 0xfeff ? 1 : 0;
  let parsed: unknown;
  try {
    parsed = JSON.parse(origin === 0 ? content : content.slice(origin));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const nb = parsed as Record<string, unknown>;
  const codeCells = notebookCodeCells(nb);
  if (!codeCells) return null;
  if (kernelShouldSkip(nb)) return null;

  const spans = codeCellArraySpans(content, origin);
  if (spans.length === 0) return null;

  const lineStarts = buildLineIndex(content);
  const chunks: string[] = [];
  const segments: NotebookLineSegment[] = [];
  let spanIndex = 0;
  let searchFrom = 0;

  for (const rawCell of codeCells) {
    if (!rawCell || typeof rawCell !== 'object') continue;
    const cell = rawCell as Record<string, unknown>;
    if (String(cell.cell_type).toLowerCase() !== 'code') continue;

    let located: { span: { start: number; end: number } | null; nextFrom: number } | null = null;
    while (spanIndex < spans.length) {
      located = findNextCodeCellSourceSpan(content, searchFrom, spans[spanIndex]);
      if (located) break;
      spanIndex++;
      searchFrom = 0;
    }
    if (!located) return null;
    searchFrom = located.nextFrom;
    if (!located.span) continue;

    const lang = cellLanguage(cell);
    if (lang !== undefined && !isPythonFamilyLanguage(lang)) {
      continue;
    }

    const { skipCell, lines } = processCellLines(flattenSource(cellSource(cell)));
    const jsonStartLine = lineFromOffset(lineStarts, firstQuoteInValue(content, located.span));
    const jsonEndLine = Math.max(jsonStartLine, lineFromOffset(lineStarts, located.span.end - 1));

    if (skipCell) {
      continue;
    }

    let text = lines.join('\n');
    const hadTrailingNewline = text.endsWith('\n');
    if (hadTrailingNewline) text = text.slice(0, -1);
    if (text.trim().length === 0) {
      continue;
    }

    if (chunks.length > 0) {
      chunks.push('\n\n');
    }
    const lineCount = hadTrailingNewline ? Math.max(1, lines.length - 1) : lines.length;
    const extractStartLine =
      segments.length === 0 ? 0 : segments[segments.length - 1].extractEndLine + 2;
    chunks.push(text);
    segments.push({
      extractStartLine,
      extractEndLine: extractStartLine + lineCount - 1,
      jsonStartLine,
      jsonEndLine,
    });
  }

  const pythonSource = chunks.join('');
  if (pythonSource.trim().length === 0) return null;
  return { pythonSource, segments };
}

export function mapExtractLine(row: number, segments: readonly NotebookLineSegment[]): number {
  if (segments.length === 0) return row;
  for (const seg of segments) {
    if (row >= seg.extractStartLine && row <= seg.extractEndLine) {
      const delta = row - seg.extractStartLine;
      const jsonSpan = seg.jsonEndLine - seg.jsonStartLine;
      return seg.jsonStartLine + Math.min(delta, jsonSpan);
    }
  }
  if (row < segments[0].extractStartLine) return segments[0].jsonStartLine;
  const last = segments[segments.length - 1];
  return last.jsonEndLine;
}

const extractCache = new Map<
  string,
  { content: string; result: NotebookPythonExtraction | null }
>();

/** Memoize extraction for FTS/CSV (same file, many symbols). */
const EXTRACT_CACHE_LIMIT = 32;

export function extractNotebookPythonCached(
  filePath: string,
  content: string,
): NotebookPythonExtraction | null {
  const hit = extractCache.get(filePath);
  if (hit && hit.content === content) return hit.result;
  const result = extractNotebookPython(content);
  if (extractCache.size >= EXTRACT_CACHE_LIMIT && !extractCache.has(filePath)) {
    const oldest = extractCache.keys().next().value;
    if (oldest !== undefined) extractCache.delete(oldest);
  }
  extractCache.set(filePath, { content, result });
  return result;
}

/** Python snippet for a graph span stored in JSON file coordinates. */
export function notebookPythonSnippetFromExtract(
  extracted: NotebookPythonExtraction,
  startLine: number,
  endLine: number,
): string | null {
  const pyLines = extracted.pythonSource.split('\n');
  const out: string[] = [];
  for (const seg of extracted.segments) {
    if (seg.jsonEndLine < startLine || seg.jsonStartLine > endLine) continue;
    for (let extract = seg.extractStartLine; extract <= seg.extractEndLine; extract++) {
      const jsonSpan = seg.jsonEndLine - seg.jsonStartLine;
      const jsonLine = seg.jsonStartLine + Math.min(extract - seg.extractStartLine, jsonSpan);
      if (jsonLine >= startLine && jsonLine <= endLine) {
        out.push(pyLines[extract] ?? '');
      }
    }
  }
  if (out.length === 0) return null;
  return out.join('\n');
}

export function notebookPythonSnippet(
  fileContent: string,
  startLine: number,
  endLine: number,
  filePath?: string,
): string | null {
  const extracted = filePath
    ? extractNotebookPythonCached(filePath, fileContent)
    : extractNotebookPython(fileContent);
  if (!extracted) return null;
  return notebookPythonSnippetFromExtract(extracted, startLine, endLine);
}
