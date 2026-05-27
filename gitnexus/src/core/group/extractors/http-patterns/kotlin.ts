import Parser from 'tree-sitter';
import { createRequire } from 'node:module';
import {
  compilePatterns,
  runCompiledPatterns,
  unquoteLiteral,
  type LanguagePatterns,
} from '../tree-sitter-scanner.js';
import type { HttpDetection, HttpLanguagePlugin } from './types.js';

/**
 * Kotlin HTTP plugin (Spring providers).
 *
 * Mirrors the Java plugin for Spring `@RequestMapping` class prefixes
 * and `@(Get|Post|...)Mapping` method annotations on Kotlin Spring
 * Boot controllers. Both positional shorthand (`@GetMapping("/x")`)
 * and named annotation arguments (`@GetMapping(value = "/x")` and
 * `@GetMapping(path = "/x")`) are supported.
 *
 * Consumer detection (RestTemplate / WebClient / OkHttp) is intentionally
 * out of scope for this plugin — Kotlin call-site ASTs are sufficiently
 * different from Java's `method_invocation` shape that they warrant a
 * separate, focused follow-up.
 *
 * tree-sitter-kotlin (fwcd) AST shapes used here:
 *   class_declaration
 *     modifiers
 *       annotation
 *         constructor_invocation
 *           user_type → type_identifier   ← annotation name
 *           value_arguments
 *             value_argument
 *               (simple_identifier  "=")? ← absent for positional, present for named
 *               string_literal
 *     type_identifier                     ← class name
 *
 * tree-sitter-kotlin is an optional npm dependency — when its native
 * binding is unavailable the plugin gracefully exports `null` and
 * `http-patterns/index.ts` skips registration for `.kt`/`.kts` files.
 */

const _require = createRequire(import.meta.url);

/** Loaded lazily; null when the grammar binding isn't installed. */
let Kotlin: unknown | null = null;
try {
  Kotlin = _require('tree-sitter-kotlin');
} catch {
  Kotlin = null;
}

const METHOD_ANNOTATION_TO_HTTP: Record<string, string> = {
  GetMapping: 'GET',
  PostMapping: 'POST',
  PutMapping: 'PUT',
  DeleteMapping: 'DELETE',
  PatchMapping: 'PATCH',
};

/**
 * Build the plugin only if the Kotlin grammar is available. Compiling
 * the queries against a null grammar would throw at module load time
 * and abort the whole http-route-extractor module.
 */
function buildKotlinPlugin(language: unknown): HttpLanguagePlugin {
  // ─── Provider: Spring class-level @RequestMapping prefix ──────────────
  // Two patterns mirror the Java plugin's positional vs named split:
  //   @RequestMapping("/api")          → value_argument has string_literal as its first named child
  //   @RequestMapping(path = "/api")   → value_argument has [simple_identifier @key, string_literal]
  //   @RequestMapping(value = "/api")  → same as above, with key="value"
  //
  // Tree-sitter-kotlin grammar (fwcd 0.3.8) does NOT have a separate
  // node for named arguments — both positional and named forms share
  // `value_argument`. The positional pattern uses the immediate-child
  // anchor `.` so it only matches when the string_literal is the FIRST
  // named child (i.e. no preceding simple_identifier "=" prefix). The
  // named pattern explicitly captures the simple_identifier and uses
  // `#match?` to restrict it to `path`/`value`, matching the same
  // safety bar that the Java plugin enforces (see java.ts and the
  // sibling topic-patterns/java.ts for the analogous constraint).
  //
  // Without the `key:` constraint the named query would also capture
  // unrelated attributes like `produces`, `consumes`, `headers`,
  // `name`, `params` — emitting bogus route contracts (a regression
  // identical to the one Claude flagged on PR #1834 for Java).
  const SPRING_CLASS_PREFIX_PATTERNS = compilePatterns({
    name: 'kotlin-spring-class-prefix',
    language,
    patterns: [
      {
        meta: {},
        query: `
          (class_declaration
            (modifiers
              (annotation
                (constructor_invocation
                  (user_type (type_identifier) @ann (#eq? @ann "RequestMapping"))
                  (value_arguments
                    (value_argument . (string_literal) @prefix)))))
            (type_identifier) @cls) @class
        `,
      },
      {
        meta: {},
        query: `
          (class_declaration
            (modifiers
              (annotation
                (constructor_invocation
                  (user_type (type_identifier) @ann (#eq? @ann "RequestMapping"))
                  (value_arguments
                    (value_argument
                      (simple_identifier) @key (#match? @key "^(path|value)$")
                      (string_literal) @prefix)))))
            (type_identifier) @cls) @class
        `,
      },
    ],
  } satisfies LanguagePatterns<Record<string, never>>);

  // ─── Provider: Spring @(Get|Post|...)Mapping method annotations ───────
  // Same dual-pattern positional/named approach. The Kotlin AST puts the
  // function name (`simple_identifier`) outside the `modifiers` subtree,
  // so we capture it from `function_declaration` directly.
  const SPRING_METHOD_ROUTE_PATTERNS = compilePatterns({
    name: 'kotlin-spring-method-route',
    language,
    patterns: [
      {
        meta: {},
        query: `
          (function_declaration
            (modifiers
              (annotation
                (constructor_invocation
                  (user_type (type_identifier) @ann (#match? @ann "^(Get|Post|Put|Delete|Patch)Mapping$"))
                  (value_arguments
                    (value_argument . (string_literal) @path)))))
            (simple_identifier) @method_name) @method
        `,
      },
      {
        meta: {},
        query: `
          (function_declaration
            (modifiers
              (annotation
                (constructor_invocation
                  (user_type (type_identifier) @ann (#match? @ann "^(Get|Post|Put|Delete|Patch)Mapping$"))
                  (value_arguments
                    (value_argument
                      (simple_identifier) @key (#match? @key "^(path|value)$")
                      (string_literal) @path)))))
            (simple_identifier) @method_name) @method
        `,
      },
    ],
  } satisfies LanguagePatterns<Record<string, never>>);

  /**
   * Find the nearest enclosing class_declaration ancestor for a node, or
   * null if the node is top-level. Mirrors the Java plugin's helper.
   */
  function findEnclosingClass(node: Parser.SyntaxNode): Parser.SyntaxNode | null {
    let cur: Parser.SyntaxNode | null = node.parent;
    while (cur) {
      if (cur.type === 'class_declaration') return cur;
      cur = cur.parent;
    }
    return null;
  }

  /**
   * Join a class-level prefix and a method-level path. Identical
   * semantics to the Java plugin: strip leading/trailing slashes on
   * the prefix, strip leading slashes on the method path, ensure a
   * single slash between them.
   */
  function joinPath(prefix: string, methodPath: string): string {
    const cleanPrefix = prefix.replace(/^\/+/, '').replace(/\/+$/, '');
    const cleanSub = methodPath.replace(/^\/+/, '');
    if (!cleanPrefix) return `/${cleanSub}`;
    return `/${cleanPrefix}/${cleanSub}`;
  }

  return {
    name: 'kotlin-http',
    language,
    scan(tree) {
      const out: HttpDetection[] = [];

      // ─── Class prefixes ─────────────────────────────────────────────
      const prefixByClassId = new Map<number, string>();
      for (const match of runCompiledPatterns(SPRING_CLASS_PREFIX_PATTERNS, tree)) {
        const prefixNode = match.captures.prefix;
        const classNode = match.captures.class;
        if (!prefixNode || !classNode) continue;
        const prefix = unquoteLiteral(prefixNode.text);
        if (prefix !== null) prefixByClassId.set(classNode.id, prefix);
      }

      // ─── Method routes ──────────────────────────────────────────────
      for (const match of runCompiledPatterns(SPRING_METHOD_ROUTE_PATTERNS, tree)) {
        const annNode = match.captures.ann;
        const pathNode = match.captures.path;
        const nameNode = match.captures.method_name;
        const methodNode = match.captures.method;
        if (!annNode || !pathNode || !methodNode) continue;
        const httpMethod = METHOD_ANNOTATION_TO_HTTP[annNode.text];
        if (!httpMethod) continue;
        const rawPath = unquoteLiteral(pathNode.text);
        if (rawPath === null) continue;
        const enclosingClass = findEnclosingClass(methodNode);
        const prefix = enclosingClass ? (prefixByClassId.get(enclosingClass.id) ?? '') : '';
        const fullPath = joinPath(prefix, rawPath);
        out.push({
          role: 'provider',
          framework: 'spring',
          method: httpMethod,
          path: fullPath,
          name: nameNode?.text ?? null,
          confidence: 0.8,
        });
      }

      return out;
    },
  };
}

/**
 * The exported plugin is `null` when tree-sitter-kotlin's native
 * binding is unavailable. `http-patterns/index.ts` checks for null
 * before registering `.kt`/`.kts` so missing optional grammars never
 * crash the orchestrator.
 */
export const KOTLIN_HTTP_PLUGIN: HttpLanguagePlugin | null = Kotlin
  ? buildKotlinPlugin(Kotlin)
  : null;
