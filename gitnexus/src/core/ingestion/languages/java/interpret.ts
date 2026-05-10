/**
 * Capture-match → semantic-shape interpreters for Java.
 *
 *   - `interpretJavaImport`       → `ParsedImport`
 *   - `interpretJavaTypeBinding`  → `ParsedTypeBinding`
 *
 * Import matches arrive pre-decomposed by `emitJavaScopeCaptures`
 * (one import per match, with synthesized `@import.kind/source/name`
 * markers). Type-binding matches arrive from the raw query captures.
 */

import type { CaptureMatch, ParsedImport, ParsedTypeBinding, TypeRef } from 'gitnexus-shared';

// ─── interpretImport ──────────────────────────────────────────────────────

export function interpretJavaImport(captures: CaptureMatch): ParsedImport | null {
  const kindCap = captures['@import.kind'];
  const sourceCap = captures['@import.source'];
  const nameCap = captures['@import.name'];

  const kind = kindCap?.text;
  if (kind === undefined || sourceCap === undefined) return null;

  switch (kind) {
    case 'named': {
      // `import com.example.User;`
      return {
        kind: 'named',
        localName: nameCap?.text ?? sourceCap.text.split('.').pop() ?? sourceCap.text,
        importedName: sourceCap.text,
        targetRaw: sourceCap.text,
      };
    }
    case 'wildcard': {
      // `import com.example.*;`
      return {
        kind: 'wildcard',
        targetRaw: sourceCap.text + '.*',
      };
    }
    case 'static': {
      // `import static com.example.Utils.format;`
      return {
        kind: 'named',
        localName: nameCap?.text ?? sourceCap.text.split('.').pop() ?? sourceCap.text,
        importedName: sourceCap.text,
        targetRaw: sourceCap.text,
      };
    }
    case 'static-wildcard': {
      // `import static com.example.Utils.*;`
      return {
        kind: 'wildcard',
        targetRaw: sourceCap.text + '.*',
      };
    }
    default:
      return null;
  }
}

// ─── interpretTypeBinding ─────────────────────────────────────────────────

export function interpretJavaTypeBinding(captures: CaptureMatch): ParsedTypeBinding | null {
  const nameCap = captures['@type-binding.name'];
  const typeCap = captures['@type-binding.type'];
  if (nameCap === undefined || typeCap === undefined) return null;

  const rawType = stripQualifier(stripGeneric(typeCap.text.trim()));

  // Skip `var` — tree-sitter-java parses `var` as type_identifier with
  // text "var". When used without a constructor initializer, there's no
  // concrete type to bind.
  if (rawType === 'var') return null;

  let source: TypeRef['source'] = 'parameter-annotation';
  if (captures['@type-binding.self'] !== undefined) source = 'self';
  else if (captures['@type-binding.constructor'] !== undefined) source = 'constructor-inferred';
  else if (captures['@type-binding.annotation'] !== undefined) source = 'annotation';
  else if (captures['@type-binding.return'] !== undefined) source = 'return-annotation';

  return { boundName: nameCap.text, rawTypeName: rawType, source };
}

/**
 * Unwrap a single-arg generic collection wrapper — `List<User>`,
 * `ArrayList<User>`, `Optional<User>` — to its element type.
 */
function stripGeneric(text: string): string {
  const single = text.match(
    /^(?:[A-Za-z_][A-Za-z0-9_.]*\.)?(?:List|ArrayList|LinkedList|Set|HashSet|TreeSet|Collection|Iterable|Iterator|Optional|Stream|CompletableFuture|Future|Queue|Deque|ArrayDeque|Vector|Stack)<([^,<>]+)>$/,
  );
  if (single !== null) return single[1].trim();
  return text;
}

/** `com.example.User` → `User`. */
function stripQualifier(text: string): string {
  const lastDot = text.lastIndexOf('.');
  if (lastDot === -1) return text;
  return text.slice(lastDot + 1);
}
