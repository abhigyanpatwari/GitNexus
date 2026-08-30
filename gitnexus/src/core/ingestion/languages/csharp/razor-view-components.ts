/**
 * ASP.NET Core ViewComponent convention support.
 *
 * Same bound as Spring Boot DI in Java/Kotlin: do not resolve into the SDK
 * (`Microsoft.AspNetCore.Mvc.ViewComponent`, `IViewComponentHelper`,
 * `Component.InvokeAsync` itself). Those types live outside the workspace.
 * The only hop worth taking is the framework convention that lands on an
 * **in-repo** class — `InvokeAsync("Foo")` → workspace `FooViewComponent`,
 * just as a Spring `@Autowired IFoo` fans out to an in-repo `@Service`,
 * not to `ApplicationContext`.
 *
 * Razor templates are not parsed as C# (markup + code would poison
 * tree-sitter-c-sharp). A small Razor state machine extracts C# islands and
 * markup tag helpers; C# files use a string/comment-aware lexer so attributes
 * and literals are not mistaken for helper calls. Literal names are enough
 * because the target catalog is already built from parsed `.cs` classes.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { glob } from 'glob';
import type { ParsedFile } from 'gitnexus-shared';
import type { KnowledgeGraph } from '../../../graph/types.js';
import { createIgnoreFilter } from '../../../../config/ignore-service.js';
import { generateId } from '../../../../lib/utils.js';
import { getMaxFileSizeBytes } from '../../utils/max-file-size.js';
import type { GraphNodeLookup } from '../../scope-resolution/graph-bridge/node-lookup.js';
import { resolveDefGraphId } from '../../scope-resolution/graph-bridge/ids.js';
import { definitionIdPosition } from '../../scope-resolution/utils/definition-id.js';

const VIEW_COMPONENT_SUFFIX = 'ViewComponent';
const VIEW_COMPONENT_TAG_RE = /<\s*vc:([a-z][a-z0-9-]*)\b/gi;
const COMPONENT_NAME_RE = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const TYPE_MODIFIERS = new Set([
  'public',
  'internal',
  'protected',
  'private',
  'abstract',
  'sealed',
  'partial',
  'static',
  'new',
  'file',
  'required',
  'unsafe',
  'readonly',
]);
const RAZOR_BLOCK_KEYWORDS = new Set([
  'if',
  'for',
  'foreach',
  'while',
  'using',
  'switch',
  'try',
  'lock',
  'functions',
  'helper',
  'code',
  'section',
  'do',
]);

export interface RazorViewComponentConfig {
  /** Repo-relative `.cshtml` path → extracted invocation names. */
  readonly views: ReadonlyMap<string, readonly string[]>;
}

export interface ViewComponentAliasBind {
  readonly className: string;
  /** 1-based line of the type declaration (including leading attributes). */
  readonly startLine: number;
  /** 0-based column of the type declaration (including leading attributes). */
  readonly startCol: number;
  readonly aliases: readonly string[];
}

class SourceCursor {
  i = 0;
  line = 1;
  col = 0;

  constructor(readonly source: string) {}

  get length(): number {
    return this.source.length;
  }

  get done(): boolean {
    return this.i >= this.source.length;
  }

  peek(n = 0): string {
    return this.source[this.i + n] ?? '';
  }

  startsWith(value: string): boolean {
    return this.source.startsWith(value, this.i);
  }

  snapshot(): { i: number; line: number; col: number } {
    return { i: this.i, line: this.line, col: this.col };
  }

  restore(pos: { i: number; line: number; col: number }): void {
    this.i = pos.i;
    this.line = pos.line;
    this.col = pos.col;
  }

  advance(count = 1): void {
    const end = Math.min(this.i + count, this.source.length);
    while (this.i < end) {
      const ch = this.source[this.i]!;
      this.i += 1;
      if (ch === '\n') {
        this.line += 1;
        this.col = 0;
      } else {
        this.col += 1;
      }
    }
  }
}

function isIdentStart(ch: string): boolean {
  return (ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z') || ch === '_' || ch === '@';
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || (ch >= '0' && ch <= '9');
}

function skipWhitespace(cur: SourceCursor): void {
  while (!cur.done) {
    const ch = cur.peek();
    if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r' && ch !== '\f' && ch !== '\v')
      break;
    cur.advance();
  }
}

/** Skip line comments and block comments. Returns true if a comment was consumed. */
function skipCsharpComment(cur: SourceCursor): boolean {
  if (cur.startsWith('//')) {
    while (!cur.done && cur.peek() !== '\n') cur.advance();
    return true;
  }
  if (cur.startsWith('/*')) {
    cur.advance(2);
    while (!cur.done && !cur.startsWith('*/')) cur.advance();
    if (cur.startsWith('*/')) cur.advance(2);
    return true;
  }
  return false;
}

function skipCsharpTrivia(cur: SourceCursor): void {
  for (;;) {
    skipWhitespace(cur);
    if (!skipCsharpComment(cur)) return;
  }
}

function skipRegularString(cur: SourceCursor, interpolated: boolean): void {
  cur.advance(); // opening "
  while (!cur.done) {
    const ch = cur.peek();
    if (ch === '\\') {
      cur.advance(2);
      continue;
    }
    if (interpolated && ch === '{') {
      if (cur.peek(1) === '{') {
        cur.advance(2);
        continue;
      }
      skipInterpolation(cur);
      continue;
    }
    cur.advance();
    if (ch === '"') return;
  }
}

function skipVerbatimString(cur: SourceCursor, interpolated: boolean): void {
  cur.advance(2); // @"
  while (!cur.done) {
    const ch = cur.peek();
    if (ch === '"') {
      if (cur.peek(1) === '"') {
        cur.advance(2);
        continue;
      }
      cur.advance();
      return;
    }
    if (interpolated && ch === '{') {
      if (cur.peek(1) === '{') {
        cur.advance(2);
        continue;
      }
      skipInterpolation(cur);
      continue;
    }
    cur.advance();
  }
}

function skipRawString(cur: SourceCursor): void {
  let quoteCount = 0;
  while (cur.peek() === '"') {
    quoteCount += 1;
    cur.advance();
  }
  while (!cur.done) {
    if (cur.peek() !== '"') {
      cur.advance();
      continue;
    }
    let seen = 0;
    while (cur.peek() === '"') {
      seen += 1;
      cur.advance();
    }
    if (seen >= quoteCount) return;
  }
}

function skipInterpolation(cur: SourceCursor): void {
  cur.advance(); // {
  let depth = 1;
  while (!cur.done && depth > 0) {
    skipCsharpTrivia(cur);
    if (cur.done) return;
    if (skipCsharpString(cur)) continue;
    const ch = cur.peek();
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
    cur.advance();
  }
}

function skipCsharpString(cur: SourceCursor): boolean {
  const ch = cur.peek();
  if (ch === "'") {
    cur.advance();
    if (cur.peek() === '\\') cur.advance(2);
    else cur.advance();
    if (cur.peek() === "'") cur.advance();
    return true;
  }
  if (ch === '"') {
    if (cur.peek(1) === '"' && cur.peek(2) === '"') skipRawString(cur);
    else skipRegularString(cur, false);
    return true;
  }
  if (ch === '$' && cur.peek(1) === '@' && cur.peek(2) === '"') {
    cur.advance();
    skipVerbatimString(cur, true);
    return true;
  }
  if (ch === '@' && cur.peek(1) === '$' && cur.peek(2) === '"') {
    cur.advance(2);
    skipVerbatimString(cur, true);
    return true;
  }
  if (ch === '@' && cur.peek(1) === '"') {
    skipVerbatimString(cur, false);
    return true;
  }
  if (ch === '$' && cur.peek(1) === '"') {
    if (cur.peek(2) === '"' && cur.peek(3) === '"') {
      cur.advance();
      skipRawString(cur);
    } else {
      cur.advance();
      skipRegularString(cur, true);
    }
    return true;
  }
  return false;
}

function readIdent(cur: SourceCursor): string | undefined {
  if (!isIdentStart(cur.peek())) return undefined;
  const start = cur.i;
  if (cur.peek() === '@') cur.advance();
  if (!isIdentStart(cur.peek()) && !(cur.peek() >= 'A' && cur.peek() <= 'z')) {
    cur.i = start;
    return undefined;
  }
  while (isIdentPart(cur.peek()) && cur.peek() !== '@') cur.advance();
  const raw = cur.source.slice(start, cur.i);
  return raw.startsWith('@') ? raw.slice(1) : raw;
}

function tryReadIdent(cur: SourceCursor): string | undefined {
  skipCsharpTrivia(cur);
  return readIdent(cur);
}

function decodeCsharpString(cur: SourceCursor): string | undefined {
  skipCsharpTrivia(cur);
  const start = cur.snapshot();
  const ch = cur.peek();
  if (ch === '$') return undefined;
  if (ch === '@' && cur.peek(1) === '"') {
    cur.advance(2);
    let value = '';
    while (!cur.done) {
      if (cur.peek() === '"') {
        if (cur.peek(1) === '"') {
          value += '"';
          cur.advance(2);
          continue;
        }
        cur.advance();
        return value;
      }
      value += cur.peek();
      cur.advance();
    }
    cur.restore(start);
    return undefined;
  }
  if (ch === '"' && cur.peek(1) === '"' && cur.peek(2) === '"') {
    let quoteCount = 0;
    while (cur.peek() === '"') {
      quoteCount += 1;
      cur.advance();
    }
    const bodyStart = cur.i;
    while (!cur.done) {
      if (cur.peek() !== '"') {
        cur.advance();
        continue;
      }
      const closeStart = cur.i;
      let seen = 0;
      while (cur.peek() === '"') {
        seen += 1;
        cur.advance();
      }
      if (seen >= quoteCount) {
        return cur.source.slice(bodyStart, closeStart);
      }
    }
    cur.restore(start);
    return undefined;
  }
  if (ch === '"') {
    cur.advance();
    let value = '';
    while (!cur.done) {
      const next = cur.peek();
      if (next === '\\') {
        cur.advance();
        const esc = cur.peek();
        cur.advance();
        const map: Record<string, string> = {
          n: '\n',
          r: '\r',
          t: '\t',
          '"': '"',
          '\\': '\\',
          '0': '\0',
        };
        value += map[esc] ?? esc;
        continue;
      }
      if (next === '"') {
        cur.advance();
        return value;
      }
      value += next;
      cur.advance();
    }
    cur.restore(start);
    return undefined;
  }
  return undefined;
}

function skipBalanced(cur: SourceCursor, open: string, close: string): boolean {
  skipCsharpTrivia(cur);
  if (cur.peek() !== open) return false;
  let depth = 0;
  while (!cur.done) {
    skipCsharpTrivia(cur);
    if (cur.done) return false;
    if (skipCsharpString(cur)) continue;
    const ch = cur.peek();
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      cur.advance();
      if (depth === 0) return true;
      continue;
    }
    cur.advance();
  }
  return false;
}

function componentNameFromLiteral(value: string | undefined): string | undefined {
  if (value === undefined || !COMPONENT_NAME_RE.test(value)) return undefined;
  return value;
}

function catalogNamesFromAlias(alias: string): string[] {
  const names = [alias];
  const dotted = alias.lastIndexOf('.');
  if (dotted >= 0) {
    const shortName = alias.slice(dotted + 1);
    if (COMPONENT_NAME_RE.test(shortName)) names.push(shortName);
  }
  return names;
}

function isViewComponentAttributeName(name: string): boolean {
  return name === 'ViewComponent' || name === 'ViewComponentAttribute';
}

function readQualifiedTail(cur: SourceCursor): string | undefined {
  skipCsharpTrivia(cur);
  let name = readIdent(cur);
  if (name === undefined) return undefined;
  for (;;) {
    skipCsharpTrivia(cur);
    if (cur.peek() === '.' || (cur.peek() === ':' && cur.peek(1) === ':')) {
      cur.advance(cur.peek() === ':' ? 2 : 1);
      skipCsharpTrivia(cur);
      const next = readIdent(cur);
      if (next === undefined) return name;
      name = next;
      continue;
    }
    return name;
  }
}

function readViewComponentNameArgument(cur: SourceCursor): string | undefined {
  skipCsharpTrivia(cur);
  if (cur.peek() !== '(') return undefined;
  cur.advance();
  let alias: string | undefined;
  while (!cur.done && cur.peek() !== ')') {
    skipCsharpTrivia(cur);
    if (cur.peek() === ')') break;
    const beforeArg = cur.snapshot();
    const ident = readIdent(cur);
    skipCsharpTrivia(cur);
    if (ident === 'Name' && cur.peek() === '=') {
      cur.advance();
      alias = componentNameFromLiteral(decodeCsharpString(cur));
    } else {
      cur.restore(beforeArg);
      skipCsharpTrivia(cur);
      if (cur.peek() === '"' || cur.peek() === '@') {
        // Positional string arguments are not ViewComponentAttribute.Name.
        skipCsharpString(cur);
      } else if (cur.peek() === '(' || cur.peek() === '[' || cur.peek() === '{') {
        const open = cur.peek();
        const close = open === '(' ? ')' : open === '[' ? ']' : '}';
        skipBalanced(cur, open, close);
      } else {
        while (!cur.done && cur.peek() !== ',' && cur.peek() !== ')') {
          if (skipCsharpString(cur)) continue;
          if (skipCsharpComment(cur)) continue;
          cur.advance();
        }
      }
    }
    skipCsharpTrivia(cur);
    if (cur.peek() === ',') cur.advance();
  }
  if (cur.peek() === ')') cur.advance();
  return alias;
}

function collectInvokeAfterIdent(
  ident: string,
  cur: SourceCursor,
  previous: string | undefined,
  names: Set<string>,
): void {
  skipCsharpTrivia(cur);
  if (ident === 'ViewComponent' && cur.peek() === '(') {
    if (previous === '[' || previous === ',') return;
    cur.advance();
    const name = componentNameFromLiteral(decodeCsharpString(cur));
    if (name !== undefined) names.add(name);
    return;
  }
  if (ident !== 'Component' || cur.peek() !== '.') return;
  const afterDot = cur.snapshot();
  cur.advance();
  skipCsharpTrivia(cur);
  if (readIdent(cur) !== 'InvokeAsync') {
    cur.restore(afterDot);
    return;
  }
  skipCsharpTrivia(cur);
  if (cur.peek() !== '(') return;
  cur.advance();
  const name = componentNameFromLiteral(decodeCsharpString(cur));
  if (name !== undefined) names.add(name);
}

/** In-repo C# `Component.InvokeAsync("X")` / `ViewComponent("X")` literals. */
export function extractCsharpViewComponentInvocations(source: string): string[] {
  if (!source.includes('ViewComponent') && !source.includes('InvokeAsync')) return [];
  const names = new Set<string>();
  const cur = new SourceCursor(source);
  let previous: string | undefined;
  let squareDepth = 0;
  while (!cur.done) {
    skipCsharpTrivia(cur);
    if (cur.done) break;
    if (skipCsharpString(cur)) {
      previous = 'string';
      continue;
    }
    const ident = readIdent(cur);
    if (ident !== undefined) {
      const inAttribute = squareDepth > 0;
      collectInvokeAfterIdent(ident, cur, inAttribute ? '[' : previous, names);
      previous = ident;
      continue;
    }
    const ch = cur.peek();
    if (ch === '[') squareDepth += 1;
    else if (ch === ']' && squareDepth > 0) squareDepth -= 1;
    previous = ch;
    cur.advance();
  }
  return [...names];
}

function parseAttributeListBody(cur: SourceCursor): string[] {
  const aliases: string[] = [];
  skipCsharpTrivia(cur);
  const specifier = cur.snapshot();
  const specifierName = readIdent(cur);
  skipCsharpTrivia(cur);
  if (specifierName !== undefined && cur.peek() === ':' && cur.peek(1) !== ':') {
    cur.advance();
  } else {
    cur.restore(specifier);
  }
  while (!cur.done && cur.peek() !== ']') {
    skipCsharpTrivia(cur);
    if (cur.peek() === ']') break;
    const tail = readQualifiedTail(cur);
    skipCsharpTrivia(cur);
    if (tail !== undefined && isViewComponentAttributeName(tail) && cur.peek() === '(') {
      const alias = readViewComponentNameArgument(cur);
      if (alias !== undefined) aliases.push(alias);
    } else if (cur.peek() === '(') {
      skipBalanced(cur, '(', ')');
    }
    skipCsharpTrivia(cur);
    if (cur.peek() === ',') cur.advance();
    else break;
  }
  if (cur.peek() === ']') cur.advance();
  return aliases;
}

/**
 * Explicit `[ViewComponent(Name = "...")]` aliases keyed to the following
 * class declaration. Positional constructor arguments are ignored: the MVC
 * attribute only exposes `Name` as a property.
 */
export function extractViewComponentAliasBinds(source: string): ViewComponentAliasBind[] {
  if (!source.includes('ViewComponent')) return [];
  const binds: ViewComponentAliasBind[] = [];
  const cur = new SourceCursor(source);
  const pending: { startLine: number; startCol: number; aliases: string[] }[] = [];

  const flushPending = (className: string, startLine: number, startCol: number): void => {
    const aliases = pending.flatMap((entry) => entry.aliases);
    const start = pending[0];
    binds.push({
      className,
      startLine: start?.startLine ?? startLine,
      startCol: start?.startCol ?? startCol,
      aliases: [...new Set(aliases.flatMap(catalogNamesFromAlias))],
    });
    pending.length = 0;
  };

  while (!cur.done) {
    skipCsharpTrivia(cur);
    if (cur.done) break;
    if (skipCsharpString(cur)) continue;
    const startLine = cur.line;
    const startCol = cur.col;
    if (cur.peek() === '[') {
      cur.advance();
      const aliases = parseAttributeListBody(cur);
      pending.push({ startLine, startCol, aliases });
      continue;
    }
    const ident = readIdent(cur);
    if (ident === undefined) {
      pending.length = 0;
      cur.advance();
      continue;
    }
    if (TYPE_MODIFIERS.has(ident)) continue;
    if (ident === 'class' || ident === 'record') {
      const className = tryReadIdent(cur);
      if (className !== undefined && pending.some((entry) => entry.aliases.length > 0)) {
        flushPending(className, startLine, startCol);
      } else {
        pending.length = 0;
      }
      continue;
    }
    pending.length = 0;
  }
  return binds;
}

/** Extract explicit `[ViewComponent(Name = "...")]` aliases by class name. */
export function extractViewComponentAliases(
  source: string,
): ReadonlyMap<string, readonly string[]> {
  const aliases = new Map<string, string[]>();
  for (const bind of extractViewComponentAliasBinds(source)) {
    if (bind.aliases.length === 0) continue;
    const existing = aliases.get(bind.className);
    if (existing) {
      for (const alias of bind.aliases) {
        if (!existing.includes(alias)) existing.push(alias);
      }
    } else {
      aliases.set(bind.className, [...bind.aliases]);
    }
  }
  return aliases;
}

function tagNameToComponentName(tagName: string): string {
  return tagName
    .split('-')
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join('');
}

function collectVcTags(span: string, names: Set<string>): void {
  VIEW_COMPONENT_TAG_RE.lastIndex = 0;
  for (const match of span.matchAll(VIEW_COMPONENT_TAG_RE)) {
    names.add(tagNameToComponentName(match[1]!));
  }
}

function skipRazorComment(cur: SourceCursor): boolean {
  if (!cur.startsWith('@*')) return false;
  cur.advance(2);
  while (!cur.done && !cur.startsWith('*@')) cur.advance();
  if (cur.startsWith('*@')) cur.advance(2);
  return true;
}

function countAtRun(cur: SourceCursor): number {
  let count = 0;
  while (cur.peek() === '@') {
    count += 1;
    cur.advance();
  }
  return count;
}

function scanCsharpSpan(span: string, names: Set<string>): void {
  for (const name of extractCsharpViewComponentInvocations(span)) names.add(name);
}

function skipOptionalParens(cur: SourceCursor): void {
  skipWhitespace(cur);
  if (cur.peek() === '(') skipBalanced(cur, '(', ')');
}

function consumeRazorCodeBlock(cur: SourceCursor, names: Set<string>): void {
  skipCsharpTrivia(cur);
  skipOptionalParens(cur);
  skipCsharpTrivia(cur);
  if (cur.peek() !== '{') {
    const start = cur.i;
    while (!cur.done && cur.peek() !== '\n' && cur.peek() !== '{') {
      if (skipCsharpString(cur) || skipCsharpComment(cur)) continue;
      cur.advance();
    }
    scanCsharpSpan(cur.source.slice(start, cur.i), names);
    if (cur.peek() === '{') consumeRazorCodeBlock(cur, names);
    return;
  }
  const bodyStart = cur.i + 1;
  if (!skipBalanced(cur, '{', '}')) return;
  scanCsharpSpan(cur.source.slice(bodyStart, cur.i - 1), names);
}

function consumeImplicitExpression(cur: SourceCursor, names: Set<string>): void {
  const start = cur.i;
  skipCsharpTrivia(cur);
  if (cur.peek() === '(') {
    const innerStart = cur.i + 1;
    if (skipBalanced(cur, '(', ')')) {
      scanCsharpSpan(cur.source.slice(innerStart, cur.i - 1), names);
    }
    return;
  }
  // Implicit expressions: `@await Component.InvokeAsync("X")` / `@Component.InvokeAsync(...)`.
  while (!cur.done) {
    skipCsharpTrivia(cur);
    if (cur.done) break;
    if (skipCsharpString(cur)) continue;
    if (cur.peek() === '(') {
      skipBalanced(cur, '(', ')');
      continue;
    }
    if (cur.peek() === '{') {
      skipBalanced(cur, '{', '}');
      continue;
    }
    const ch = cur.peek();
    if (ch === '<' || ch === '\n') break;
    if (ch === '@') break;
    if (!isIdentPart(ch) && ch !== '.' && ch !== '?') {
      if (ch === ';') cur.advance();
      break;
    }
    cur.advance();
  }
  scanCsharpSpan(cur.source.slice(start, cur.i), names);
}

function consumeRazorTransition(cur: SourceCursor, names: Set<string>): void {
  skipWhitespace(cur);
  if (cur.peek() === '{') {
    consumeRazorCodeBlock(cur, names);
    return;
  }
  if (cur.peek() === '(') {
    consumeImplicitExpression(cur, names);
    return;
  }
  const identStart = cur.snapshot();
  const ident = readIdent(cur);
  if (ident === undefined) {
    consumeImplicitExpression(cur, names);
    return;
  }
  if (ident === 'await' || ident === 'Component') {
    cur.restore(identStart);
    consumeImplicitExpression(cur, names);
    return;
  }
  if (RAZOR_BLOCK_KEYWORDS.has(ident)) {
    if (ident === 'section' || ident === 'helper') tryReadIdent(cur);
    consumeRazorCodeBlock(cur, names);
    return;
  }
  cur.restore(identStart);
  consumeImplicitExpression(cur, names);
}

/** Extract statically resolvable ViewComponent names from one Razor template. */
export function extractRazorViewComponentInvocations(source: string): string[] {
  // Most views do not invoke a ViewComponent. Avoid the character-by-character
  // Razor scan unless one of the two supported invocation spellings is present.
  // This is only a coarse gate; the state machine below still decides whether a
  // token is executable markup/C# or a comment/string/escaped transition.
  if (!source.includes('InvokeAsync') && !/<\s*vc:/i.test(source)) return [];

  const names = new Set<string>();
  const cur = new SourceCursor(source);
  let markupStart = 0;
  const flushMarkup = (): void => {
    if (cur.i > markupStart) collectVcTags(source.slice(markupStart, cur.i), names);
  };

  while (!cur.done) {
    if (cur.peek() !== '@') {
      cur.advance();
      continue;
    }
    flushMarkup();
    if (skipRazorComment(cur)) {
      markupStart = cur.i;
      continue;
    }
    const atCount = countAtRun(cur);
    const leftover = atCount % 2;
    if (leftover === 0) {
      markupStart = cur.i;
      continue;
    }
    consumeRazorTransition(cur, names);
    markupStart = cur.i;
  }
  flushMarkup();
  return [...names];
}

/**
 * Read Razor views once per C# resolution pass. The same ignore rules and file
 * size ceiling as repository scanning are applied, and edge emission later
 * additionally requires a live File node. This prevents ignored, oversized,
 * or concurrently removed templates from entering the graph.
 */
export async function loadRazorViewComponentConfig(
  repoRoot: string,
): Promise<RazorViewComponentConfig> {
  const ignore = await createIgnoreFilter(repoRoot);
  const paths = await glob('**/*.cshtml', {
    cwd: repoRoot,
    nodir: true,
    dot: false,
    ignore,
  });
  paths.sort();

  const maxBytes = getMaxFileSizeBytes();
  const views = new Map<string, readonly string[]>();
  for (const rawPath of paths) {
    const filePath = rawPath.replace(/\\/g, '/');
    try {
      const fullPath = path.join(repoRoot, filePath);
      const stat = await fs.stat(fullPath);
      if (!stat.isFile() || stat.size > maxBytes) continue;
      const source = await fs.readFile(fullPath, 'utf8');
      views.set(filePath, extractRazorViewComponentInvocations(source));
    } catch {
      // A view may disappear between glob/stat/read during watch mode.
    }
  }
  return { views };
}

function addCandidate(
  candidates: Map<string, Set<string>>,
  invocationName: string,
  targetId: string,
): void {
  const key = invocationName.toLocaleLowerCase('en-US');
  const existing = candidates.get(key);
  if (existing) {
    existing.add(targetId);
  } else {
    candidates.set(key, new Set([targetId]));
  }
}

function bindAliasesForClass(
  binds: readonly ViewComponentAliasBind[],
  className: string,
  nodeId: string,
  filePath: string,
): readonly string[] | undefined {
  const matches = binds.filter((bind) => bind.className === className);
  if (matches.length === 0) return undefined;
  if (matches.length === 1) return matches[0]!.aliases;
  const pos = definitionIdPosition(nodeId, filePath);
  if (pos === undefined) return undefined;
  const atPosition = matches.filter(
    (bind) => bind.startLine === pos.line && bind.startCol === pos.column,
  );
  if (atPosition.length === 1) return atPosition[0]!.aliases;
  return undefined;
}

/**
 * Emit workspace File → in-repo ViewComponent Class CALLS edges.
 *
 * Targets are only Class nodes produced from this repo's `.cs` files. There is
 * no lookup of ASP.NET SDK types; `: ViewComponent` in source is a naming
 * hint, not a resolved EXTENDS edge to `Microsoft.AspNetCore.Mvc.ViewComponent`.
 *
 * Ambiguous component names fail closed: two in-repo classes claiming the
 * same name is not evidence for picking either one.
 */
export function emitRazorViewComponentEdges(
  graph: KnowledgeGraph,
  parsedFiles: readonly ParsedFile[],
  nodeLookup: GraphNodeLookup,
  config: RazorViewComponentConfig | undefined,
  csharpSources: ReadonlyMap<string, string>,
): void {
  if (!config) return;

  const candidates = new Map<string, Set<string>>();
  for (const parsed of parsedFiles) {
    if (!parsed.filePath.endsWith('.cs')) continue;
    const source = csharpSources.get(parsed.filePath) ?? '';
    const binds = source.includes('ViewComponent') ? extractViewComponentAliasBinds(source) : [];
    for (const def of parsed.localDefs) {
      if (def.type !== 'Class') continue;
      const className = def.qualifiedName?.split('.').pop() ?? def.nodeId.split(':').pop() ?? '';
      const conventionalName = className.endsWith(VIEW_COMPONENT_SUFFIX)
        ? className.slice(0, -VIEW_COMPONENT_SUFFIX.length)
        : undefined;
      const explicitAliases = bindAliasesForClass(binds, className, def.nodeId, parsed.filePath);
      if (!conventionalName && (explicitAliases === undefined || explicitAliases.length === 0)) {
        continue;
      }

      const targetId = resolveDefGraphId(parsed.filePath, def, nodeLookup);
      if (!targetId || !graph.getNode(targetId)) continue;
      // An explicit [ViewComponent(Name = "...")] replaces the suffix name,
      // matching ASP.NET. Never register the SDK base type as a candidate.
      if (explicitAliases !== undefined && explicitAliases.length > 0) {
        for (const alias of explicitAliases) addCandidate(candidates, alias, targetId);
      } else if (conventionalName) {
        addCandidate(candidates, conventionalName, targetId);
      }
    }
  }

  const emitFromFile = (filePath: string, invocationNames: readonly string[]): void => {
    const sourceId = generateId('File', filePath);
    if (!graph.getNode(sourceId)) return;
    for (const invocationName of invocationNames) {
      const matches = candidates.get(invocationName.toLocaleLowerCase('en-US'));
      if (!matches || matches.size !== 1) continue;
      const targetId = matches.values().next().value;
      if (typeof targetId !== 'string' || !graph.getNode(targetId)) continue;
      graph.addRelationship({
        id: generateId('CALLS', `${sourceId}:razor-view-component:${targetId}`),
        sourceId,
        targetId,
        type: 'CALLS',
        confidence: 0.9,
        reason: 'aspnet-razor-view-component',
      });
    }
  };

  for (const [viewPath, invocationNames] of config.views) {
    emitFromFile(viewPath, invocationNames);
  }
  for (const [filePath, source] of csharpSources) {
    if (!filePath.endsWith('.cs')) continue;
    if (!source.includes('ViewComponent') && !source.includes('InvokeAsync')) continue;
    emitFromFile(filePath, extractCsharpViewComponentInvocations(source));
  }
}
