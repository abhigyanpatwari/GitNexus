/**
 * Unreal Engine reflection-macro preprocessor for C++ source.
 *
 * Tree-sitter does not expand C preprocessor macros, so Unreal's reflection
 * markers (`UCLASS(...)`, `UFUNCTION(...)`, `MODULENAME_API`, ...) are parsed
 * verbatim. The result is mis-parsed declarations: in `class BRAWLUI_API
 * UMyClass : public UObject`, tree-sitter-cpp captures `BRAWLUI_API` as the
 * class name and the rest of the declaration becomes structurally wrong.
 *
 * This module elides those macros from the source text BEFORE tree-sitter
 * parses it. Replacement is **length-preserving** (each elided byte becomes
 * a space, newlines preserved) so byte offsets and line/column positions
 * tree-sitter reports remain identical to the original file. Symbol
 * locations in the graph stay accurate.
 *
 * A cheap detection guard short-circuits files that don't look like UE
 * sources, so non-UE C++ codebases pay no cost.
 *
 * Pure function — no tree-sitter dependency, safe for worker threads.
 */
/**
 * Strong UE markers — reflection macros that only Unreal Engine projects use.
 * Presence of one of these is sufficient evidence that the file is a UE source
 * and that `MODULENAME_API` tokens in it are intended as export macros.
 *
 * Importantly, `_API` tokens are NOT in this guard — `REST_API`, `HTTP_API`,
 * `MY_LIB_API` and similar identifiers appear in plenty of non-UE C++ codebases
 * as constants/enums/parameter names. We must not erase them just because the
 * file mentions an `_API` token.
 */
const HAS_UE_HINT =
  /\b(?:UCLASS|UFUNCTION|UPROPERTY|USTRUCT|UENUM|UINTERFACE|GENERATED_BODY|GENERATED_[A-Z_]+_BODY|UE_DEPRECATED|DECLARE_(?:DYNAMIC_)?(?:MULTICAST_)?DELEGATE)/;

const SIMPLE_MACROS_NO_ARGS: readonly string[] = [
  'GENERATED_BODY',
  'GENERATED_UCLASS_BODY',
  'GENERATED_USTRUCT_BODY',
  'GENERATED_UINTERFACE_BODY',
  'GENERATED_IINTERFACE_BODY',
  'DECLARE_CLASS',
  'GENERATED_BODY_LEGACY',
];

const PARENTHESIZED_MACROS: readonly string[] = [
  'UCLASS',
  'UFUNCTION',
  'UPROPERTY',
  'USTRUCT',
  'UENUM',
  'UINTERFACE',
  'UMETA',
  'UE_DEPRECATED',
];

const DELEGATE_MACRO_RE =
  /\bDECLARE_(?:DYNAMIC_)?(?:MULTICAST_)?DELEGATE(?:_(?:RetVal_OneParam|RetVal_TwoParams|RetVal_ThreeParams|RetVal_FourParams|RetVal_FiveParams|RetVal_SixParams|RetVal_SevenParams|RetVal_EightParams|RetVal_NineParams|RetVal|OneParam|TwoParams|ThreeParams|FourParams|FiveParams|SixParams|SevenParams|EightParams|NineParams|TenParams))?(?=\s*\()/g;

/**
 * Module export tokens like `BRAWLUI_API`, `ENGINE_API`, `COREUOBJECT_API`.
 * Pattern: ALL_CAPS identifier ending in `_API`. The leading word boundary
 * (`\b`) prevents matching mid-identifier.
 */
const API_MACRO_RE = /\b[A-Z][A-Z0-9_]*_API\b/g;

/** Replace `[start, end)` of `chars` with spaces, preserving newlines. */
function eraseRange(chars: string[], start: number, end: number): void {
  for (let i = start; i < end; i++) {
    if (chars[i] !== '\n' && chars[i] !== '\r') {
      chars[i] = ' ';
    }
  }
}

/**
 * Find the matching close paren for an opening paren at index `openIdx`.
 * Returns the index of `)` (inclusive end), or -1 if unbalanced.
 *
 * Handles nested parens and string/char literals so commas/parens inside
 * strings don't throw off the match. Does not attempt to handle raw string
 * literals (`R"(...)"`); UE reflection-macro arguments do not use them in
 * practice.
 */
function findMatchingParen(source: string, openIdx: number): number {
  if (source.charCodeAt(openIdx) !== 0x28) return -1;
  let depth = 1;
  let i = openIdx + 1;
  const len = source.length;
  while (i < len && depth > 0) {
    const ch = source.charCodeAt(i);
    // String literal
    if (ch === 0x22) {
      i++;
      while (i < len) {
        const c = source.charCodeAt(i);
        if (c === 0x5c) {
          i += 2;
          continue;
        }
        if (c === 0x22) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // Char literal
    if (ch === 0x27) {
      i++;
      while (i < len) {
        const c = source.charCodeAt(i);
        if (c === 0x5c) {
          i += 2;
          continue;
        }
        if (c === 0x27) {
          i++;
          break;
        }
        i++;
      }
      continue;
    }
    // Line comment
    if (ch === 0x2f && source.charCodeAt(i + 1) === 0x2f) {
      while (i < len && source.charCodeAt(i) !== 0x0a) i++;
      continue;
    }
    // Block comment
    if (ch === 0x2f && source.charCodeAt(i + 1) === 0x2a) {
      i += 2;
      while (i < len) {
        if (source.charCodeAt(i) === 0x2a && source.charCodeAt(i + 1) === 0x2f) {
          i += 2;
          break;
        }
        i++;
      }
      continue;
    }
    if (ch === 0x28) depth++;
    else if (ch === 0x29) {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/** Match a whole-word identifier at `idx`. Returns the byte after the identifier, or -1 on miss. */
function matchIdentifierAt(source: string, idx: number, name: string): number {
  if (idx > 0) {
    const prev = source.charCodeAt(idx - 1);
    if (
      (prev >= 0x30 && prev <= 0x39) ||
      (prev >= 0x41 && prev <= 0x5a) ||
      (prev >= 0x61 && prev <= 0x7a) ||
      prev === 0x5f
    ) {
      return -1;
    }
  }
  for (let k = 0; k < name.length; k++) {
    if (source.charCodeAt(idx + k) !== name.charCodeAt(k)) return -1;
  }
  const after = idx + name.length;
  if (after < source.length) {
    const next = source.charCodeAt(after);
    if (
      (next >= 0x30 && next <= 0x39) ||
      (next >= 0x41 && next <= 0x5a) ||
      (next >= 0x61 && next <= 0x7a) ||
      next === 0x5f
    ) {
      return -1;
    }
  }
  return after;
}

/** Skip ASCII whitespace forward from `idx`. Returns the next non-whitespace byte index. */
function skipWhitespace(source: string, idx: number): number {
  const len = source.length;
  while (idx < len) {
    const ch = source.charCodeAt(idx);
    if (ch === 0x20 || ch === 0x09 || ch === 0x0a || ch === 0x0d) {
      idx++;
      continue;
    }
    break;
  }
  return idx;
}

/**
 * Strip Unreal Engine reflection macros from C++ source, length-preserving.
 *
 * Returns the original string unchanged if no strong UE marker is detected,
 * so non-UE C++ files (including ones that contain `*_API`-suffixed
 * identifiers like `REST_API` or `HTTP_API`) incur only a single regex test.
 *
 * The `_filePath` parameter is part of the `LanguageProvider.preprocessSource`
 * contract but is unused — UE detection is purely content-based. Accepted and
 * ignored here so the function matches the hook signature exactly.
 */
export function stripUeMacros(source: string, _filePath?: string): string {
  if (!HAS_UE_HINT.test(source)) return source;

  const chars: string[] = source.split('');

  for (const macro of PARENTHESIZED_MACROS) {
    let searchFrom = 0;
    while (true) {
      const hit = source.indexOf(macro, searchFrom);
      if (hit < 0) break;
      searchFrom = hit + 1;
      const after = matchIdentifierAt(source, hit, macro);
      if (after < 0) continue;
      const parenIdx = skipWhitespace(source, after);
      if (source.charCodeAt(parenIdx) !== 0x28) continue;
      const close = findMatchingParen(source, parenIdx);
      if (close < 0) continue;
      eraseRange(chars, hit, close + 1);
    }
  }

  for (const macro of SIMPLE_MACROS_NO_ARGS) {
    let searchFrom = 0;
    while (true) {
      const hit = source.indexOf(macro, searchFrom);
      if (hit < 0) break;
      searchFrom = hit + 1;
      const after = matchIdentifierAt(source, hit, macro);
      if (after < 0) continue;
      const parenIdx = skipWhitespace(source, after);
      if (source.charCodeAt(parenIdx) === 0x28) {
        const close = findMatchingParen(source, parenIdx);
        if (close < 0) continue;
        eraseRange(chars, hit, close + 1);
      } else {
        eraseRange(chars, hit, after);
      }
    }
  }

  for (const re of [DELEGATE_MACRO_RE, API_MACRO_RE]) {
    re.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = re.exec(source)) !== null) {
      const start = match.index;
      let end = start + match[0].length;
      if (re === DELEGATE_MACRO_RE) {
        const parenIdx = skipWhitespace(source, end);
        if (source.charCodeAt(parenIdx) === 0x28) {
          const close = findMatchingParen(source, parenIdx);
          if (close >= 0) end = close + 1;
        }
      }
      eraseRange(chars, start, end);
    }
  }

  return chars.join('');
}
