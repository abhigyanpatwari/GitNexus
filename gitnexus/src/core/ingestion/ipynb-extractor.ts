/**
 * Jupyter notebook (.ipynb) Python extractor.
 *
 * Pulls code-cell source from nbformat JSON so the Python tree-sitter
 * grammar can parse it. Pure — no I/O, no tree-sitter, worker-safe.
 *
 * Graph coordinates stay 0-based lines in the on-disk JSON file. Extract
 * buffer lines map through {@link mapExtractLine}.
 */

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

const PYTHON_FAMILY = new Set(['python', 'python2', 'python3', 'ipython']);

export function isPythonFamilyLanguage(name: string | undefined | null): boolean {
  if (name === undefined || name === null) return false;
  const n = name.trim().toLowerCase();
  if (PYTHON_FAMILY.has(n)) return true;
  return /^python\d/.test(n);
}

function indexToLine(content: string, index: number): number {
  let line = 0;
  const end = Math.max(0, Math.min(index, content.length));
  for (let i = 0; i < end; i++) {
    if (content.charCodeAt(i) === 10) line++;
  }
  return line;
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

function findNextCodeCellSourceSpan(
  content: string,
  from: number,
): { span: { start: number; end: number }; nextFrom: number } | null {
  let search = from;
  while (search < content.length) {
    const typeKey = content.indexOf('"cell_type"', search);
    if (typeKey < 0) return null;
    const colon = content.indexOf(':', typeKey + 11);
    if (colon < 0) return null;
    const valueStart = skipWs(content, colon + 1);
    if (content.slice(valueStart, valueStart + 6) !== '"code"') {
      search = typeKey + 11;
      continue;
    }
    const sourceKey = content.indexOf('"source"', valueStart);
    if (sourceKey < 0) return null;
    const srcColon = content.indexOf(':', sourceKey + 8);
    if (srcColon < 0) return null;
    const span = jsonValueSpan(content, srcColon + 1);
    if (!span) return null;
    return { span, nextFrom: span.end };
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
      ks && typeof ks === 'object' && typeof (ks as Record<string, unknown>).language === 'string'
        ? String((ks as Record<string, unknown>).language)
        : undefined,
    languageInfo:
      li && typeof li === 'object' && typeof (li as Record<string, unknown>).name === 'string'
        ? String((li as Record<string, unknown>).name)
        : undefined,
  };
}

function kernelShouldSkip(nb: Record<string, unknown>): boolean {
  const { kernelspec, languageInfo } = notebookLanguageFields(nb);
  const fields = [kernelspec, languageInfo].filter((x): x is string => x !== undefined);
  if (fields.length === 0) return false;
  if (fields.some((f) => !isPythonFamilyLanguage(f))) return true;
  if (fields.length === 2 && fields[0].toLowerCase() !== fields[1].toLowerCase()) {
    const a = isPythonFamilyLanguage(fields[0]);
    const b = isPythonFamilyLanguage(fields[1]);
    if (a !== b) return true;
  }
  return false;
}

function processCellLines(raw: string): { skipCell: boolean; lines: string[] } {
  const lines = raw.split('\n');
  const firstNonEmpty = lines.find((l) => l.trim().length > 0);
  if (firstNonEmpty !== undefined && firstNonEmpty.trimStart().startsWith('%%')) {
    return { skipCell: true, lines: [''] };
  }
  const out = lines.map((line) => {
    const t = line.trimStart();
    if (t.startsWith('%') || t.startsWith('!')) {
      return `# ${line}`;
    }
    return line;
  });
  return { skipCell: false, lines: out };
}

export function extractNotebookPython(content: string): NotebookPythonExtraction | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const nb = parsed as Record<string, unknown>;
  if (!Array.isArray(nb.cells)) return null;
  if (kernelShouldSkip(nb)) return null;

  const chunks: string[] = [];
  const segments: NotebookLineSegment[] = [];
  let searchFrom = 0;

  for (const rawCell of nb.cells) {
    if (!rawCell || typeof rawCell !== 'object') continue;
    const cell = rawCell as Record<string, unknown>;
    if (cell.cell_type !== 'code') continue;

    const located = findNextCodeCellSourceSpan(content, searchFrom);
    if (!located) return null;
    searchFrom = located.nextFrom;

    const lang = cellLanguage(cell);
    if (lang !== undefined && !isPythonFamilyLanguage(lang)) {
      continue;
    }

    const { skipCell, lines } = processCellLines(flattenSource(cell.source));
    const jsonStartLine = indexToLine(content, located.span.start);
    const jsonEndLine = Math.max(jsonStartLine, indexToLine(content, located.span.end - 1));

    if (skipCell) {
      continue;
    }

    let text = lines.join('\n');
    if (text.endsWith('\n')) text = text.slice(0, -1);
    if (text.trim().length === 0) {
      continue;
    }

    if (chunks.length > 0) {
      chunks.push('\n\n');
    }
    chunks.push(text);
    const assembled = chunks.join('');
    const extractStartLine = indexToLine(assembled, assembled.length - text.length);
    const extractEndLine = indexToLine(assembled, assembled.length - 1);
    segments.push({
      extractStartLine,
      extractEndLine,
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
export function extractNotebookPythonCached(
  filePath: string,
  content: string,
): NotebookPythonExtraction | null {
  const hit = extractCache.get(filePath);
  if (hit && hit.content === content) return hit.result;
  const result = extractNotebookPython(content);
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
    for (let extract = seg.extractStartLine; extract <= seg.extractEndLine; extract++) {
      const jsonLine = mapExtractLine(extract, extracted.segments);
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
