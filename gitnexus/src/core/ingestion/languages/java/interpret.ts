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
      const simpleName = sourceCap.text.split('.').pop() ?? sourceCap.text;
      return {
        kind: 'named',
        localName: nameCap?.text ?? simpleName,
        importedName: simpleName,
        targetRaw: sourceCap.text,
        targetIncludesImportedName: true,
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
      const fullSource = sourceCap.text;
      const lastDot = fullSource.lastIndexOf('.');
      const memberName = lastDot >= 0 ? fullSource.slice(lastDot + 1) : fullSource;
      const classPath = lastDot >= 0 ? fullSource.slice(0, lastDot) : fullSource;
      return {
        kind: 'named',
        localName: nameCap?.text ?? memberName,
        importedName: memberName,
        targetRaw: classPath,
      };
    }
    case 'static-wildcard': {
      // `import static com.example.Utils.*;`
      // The source is the class path (e.g. `com.example.Utils`).
      // Resolution should target the class file, not a wildcard directory
      // scan — `Utils.java` is the file that contains the static members.
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

  // Strip generics BEFORE the qualifier (F41 #1928). Stripping the qualifier
  // first uses `lastIndexOf('.')`, which for a qualified *type argument*
  // (`Map<String, com.example.User>`) cuts inside the generic and yields a
  // corrupted `User>`. Unwrapping generics first reduces the string to a single
  // (possibly qualified) class name, then the qualifier strip leaves the bare
  // simple name. `stripGeneric`'s erasure fallback is qualifier-tolerant so a
  // qualified generic base (`com.example.BaseModel<T>`) still reduces correctly.
  const rawType = stripQualifier(stripGeneric(typeCap.text.trim()));

  // Skip `var` — tree-sitter-java parses `var` as type_identifier with
  // text "var". When used without a constructor initializer, there's no
  // concrete type to bind.
  if (rawType === 'var') return null;

  let source: TypeRef['source'] = 'parameter-annotation';
  if (captures['@type-binding.self'] !== undefined) source = 'self';
  else if (captures['@type-binding.constructor'] !== undefined) source = 'constructor-inferred';
  else if (captures['@type-binding.pattern'] !== undefined) source = 'annotation';
  else if (captures['@type-binding.call-result'] !== undefined) source = 'annotation';
  else if (captures['@type-binding.alias'] !== undefined) source = 'annotation';
  else if (captures['@type-binding.annotation'] !== undefined) source = 'annotation';
  else if (captures['@type-binding.return'] !== undefined) source = 'return-annotation';

  return { boundName: nameCap.text, rawTypeName: rawType, source };
}

/**
 * Unwrap generic type parameters from Java types.
 *
 * Three tiers, checked in order:
 *   1. Known single-arg collection wrappers → extract the element type
 *      (`List<User>` → `User`, `Optional<User>` → `User`).
 *   2. Known two-arg map/container types → extract the value type
 *      (`Map<String, User>` → `User`).
 *   3. **Fallback (JVM type erasure):** any other generic type →
 *      strip the generic parameters and keep the raw class name
 *      (`BaseModel<T>` → `BaseModel`, `CustomList<Foo>` → `CustomList`).
 *      This ensures receiver bindings (`this`/`super`) on classes with
 *      generic superclasses resolve to the correct class file.
 */
function stripGeneric(text: string): string {
  // Single-type-argument containers — extract the element type.
  const single = text.match(
    /^(?:[A-Za-z_][A-Za-z0-9_.]*\.)?(?:List|ArrayList|LinkedList|Set|HashSet|TreeSet|SortedSet|LinkedHashSet|Collection|Iterable|Iterator|Optional|Stream|CompletableFuture|Future|Queue|Deque|ArrayDeque|PriorityQueue|Vector|Stack|Supplier|Consumer|Predicate|Function)<([^,<>]+)>$/,
  );
  if (single !== null) return single[1].trim();

  // Two-type-argument map/container types — extract the value type (second arg).
  const twoArg = text.match(
    /^(?:[A-Za-z_][A-Za-z0-9_.]*\.)?(?:Map|HashMap|TreeMap|LinkedHashMap|ConcurrentHashMap|ConcurrentMap|SortedMap|NavigableMap|Hashtable|EnumMap|WeakHashMap|IdentityHashMap|BiFunction|BiConsumer|BiPredicate|Pair|Entry)<[^,<>]+,\s*([^,<>]+)>$/,
  );
  if (twoArg !== null) return twoArg[1].trim();

  // Fallback: strip generic parameters from any unrecognized generic type.
  // `BaseModel<T>` → `BaseModel`, `Builder<Self>` → `Builder`.
  // This mirrors JVM type erasure — the raw class name is the resolvable symbol.
  // The pattern matches up to the first `<` to handle nested generics safely
  // (e.g. `BaseModel<List<String>>` → `BaseModel`). The base is allowed to be
  // qualified (`com.example.BaseModel<T>` → `com.example.BaseModel`) since the
  // caller strips the qualifier afterwards (F41 #1928).
  const fallback = text.match(/^((?:[A-Za-z_$][A-Za-z0-9_$]*\.)*[A-Za-z_$][A-Za-z0-9_$]*)<.+>$/s);
  if (fallback !== null) return fallback[1].trim();

  return text;
}

/** `com.example.User` → `User`. */
function stripQualifier(text: string): string {
  const lastDot = text.lastIndexOf('.');
  if (lastDot === -1) return text;
  return text.slice(lastDot + 1);
}
