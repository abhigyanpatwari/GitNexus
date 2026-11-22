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
import { eraseJavaTypeArguments } from './type-spelling.js';

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
        reexportsName: false,
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
      // scan — keeping the type path unstarred also distinguishes it from a
      // package wildcard when a same-named package exists.
      return {
        kind: 'wildcard',
        targetRaw: sourceCap.text,
        reexportsName: false,
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

  // Selected-call assignment facts carry the exact producer; a bare method
  // name cannot prove which overload/owner produced a `var` initializer.
  if (captures['@type-binding.call-result'] !== undefined) return null;
  if (captures['@type-binding.alias'] !== undefined) {
    return {
      boundName: nameCap.text,
      rawTypeName: typeCap.text.trim(),
      source: 'assignment-inferred',
    };
  }

  // Strip generics BEFORE the qualifier (F41 #1928). Stripping the qualifier
  // first uses `lastIndexOf('.')`, which for a qualified *type argument*
  // (`Map<String, com.example.User>`) cuts inside the generic and yields a
  // corrupted `User>`. Erasing generics first retains the (possibly qualified)
  // container/class name, then the qualifier strip leaves the simple name.
  // Erasure is qualifier-tolerant so a
  // qualified generic base (`com.example.BaseModel<T>`) still reduces correctly.
  const rawType = stripQualifier(eraseJavaTypeArguments(typeCap.text.trim()));

  // Skip `var` — tree-sitter-java parses `var` as type_identifier with
  // text "var". When used without a constructor initializer, there's no
  // concrete type to bind.
  if (rawType === 'var') return null;

  let source: TypeRef['source'] = 'parameter-annotation';
  if (captures['@type-binding.contextual-qualified'] !== undefined) source = 'receiver-propagated';
  else if (captures['@type-binding.self'] !== undefined) source = 'self';
  else if (captures['@type-binding.constructor'] !== undefined) source = 'constructor-inferred';
  else if (captures['@type-binding.pattern'] !== undefined) source = 'annotation';
  else if (captures['@type-binding.annotation'] !== undefined) source = 'annotation';
  else if (captures['@type-binding.return'] !== undefined) source = 'return-annotation';

  return { boundName: nameCap.text, rawTypeName: rawType, source };
}

/** `com.example.User` → `User`. */
function stripQualifier(text: string): string {
  const lastDot = text.lastIndexOf('.');
  if (lastDot === -1) return text;
  return text.slice(lastDot + 1);
}
