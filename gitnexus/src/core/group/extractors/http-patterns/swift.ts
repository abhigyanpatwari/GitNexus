import Swift from 'tree-sitter-swift';
import {
  compilePatterns,
  runCompiledPatterns,
  unquoteLiteral,
  type LanguagePatterns,
} from '../tree-sitter-scanner.js';
import type { HttpDetection, HttpLanguagePlugin } from './types.js';

/**
 * Swift HTTP plugin. Targets the verb-method style that wraps URLRequest /
 * URLSession / Alamofire in a single helper, which is the dominant pattern
 * in iOS / macOS / Swift-on-server codebases. Two shapes:
 *
 *   - Labeled `path:` argument: `Client.get(path: "/api/foo")` or
 *     `Client.post(path: "/api/foo", body: …)` — common in hand-rolled
 *     wrappers (e.g. `enum Client { static func get(path: …) … }`).
 *
 *   - Positional first-argument string: `AF.request("/api/foo", method: .post)`
 *     or `client.get("/api/foo")` — common in Alamofire and in lightweight
 *     wrapper APIs that mimic the JS/TS `fetch(url)` shape.
 *
 * In both cases the method comes from the navigation-suffix identifier
 * (`get`/`post`/`put`/`delete`/`patch`). We intentionally do NOT try to
 * extract method from a `request.httpMethod = "POST"` assignment that
 * lives in a different statement — correlating those requires intra-
 * procedural analysis the source-scan path doesn't have. Such requests
 * still fall through to the verb-method patterns when wrapped, which is
 * how real-world Swift codebases factor this.
 */

const SWIFT_VERB_REGEX = '^(get|post|put|delete|patch)$';

// Pattern A — labeled `path:` argument: `Client.get(path: "/api/foo")`.
// Matches the iOS-style wrapper where the path is a labeled string and
// the verb is the navigation-suffix identifier. The simple_identifier
// receiver on the navigation_expression is not constrained — any
// `Foo.get(path: "…")` qualifies.
const LABELED_PATH_PATTERNS = compilePatterns({
  name: 'swift-verb-path-labeled',
  language: Swift,
  patterns: [
    {
      meta: {},
      query: `
        (call_expression
          (navigation_expression
            (navigation_suffix
              (simple_identifier) @verb (#match? @verb "${SWIFT_VERB_REGEX}")))
          (call_suffix
            (value_arguments
              (value_argument
                (value_argument_label (simple_identifier) @label (#eq? @label "path"))
                (line_string_literal (line_str_text) @path)))))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

// Pattern B — positional first argument: `AF.request("/api/foo", method: .post)`,
// `client.get("/api/foo")`. The first value_argument carries a
// line_string_literal directly (no value_argument_label sibling).
//
// Pattern B is split into two query variants because Tree-sitter has no
// concise way to say "the first argument has NO label" within a single
// query. The post-filter in `scan` rejects any match where the first
// argument turns out to have a value_argument_label (e.g. `path:`),
// since pattern A already covers that.
const POSITIONAL_PATH_PATTERNS = compilePatterns({
  name: 'swift-verb-positional',
  language: Swift,
  patterns: [
    {
      meta: {},
      query: `
        (call_expression
          (navigation_expression
            (navigation_suffix
              (simple_identifier) @verb (#match? @verb "${SWIFT_VERB_REGEX}")))
          (call_suffix
            (value_arguments
              .
              (value_argument
                (line_string_literal (line_str_text) @path)) @first_arg)))
      `,
    },
  ],
} satisfies LanguagePatterns<Record<string, never>>);

export const SWIFT_HTTP_PLUGIN: HttpLanguagePlugin = {
  name: 'swift-http',
  language: Swift,
  scan(tree) {
    const out: HttpDetection[] = [];

    // Pattern A: labeled `path:` argument.
    for (const match of runCompiledPatterns(LABELED_PATH_PATTERNS, tree)) {
      const verbNode = match.captures.verb;
      const pathNode = match.captures.path;
      if (!verbNode || !pathNode) continue;
      const path = unquoteLiteral(pathNode.text);
      if (path === null) continue;
      out.push({
        role: 'consumer',
        framework: 'swift-verb-method',
        method: verbNode.text.toUpperCase(),
        path,
        name: null,
        confidence: 0.7,
      });
    }

    // Pattern B: positional first argument. Drop any match where the
    // first argument carries a label (already covered by pattern A).
    const seen = new Set<number>();
    for (const match of runCompiledPatterns(POSITIONAL_PATH_PATTERNS, tree)) {
      const verbNode = match.captures.verb;
      const pathNode = match.captures.path;
      const firstArgNode = match.captures.first_arg;
      if (!verbNode || !pathNode || !firstArgNode) continue;
      // Reject if the first_arg is actually a labeled argument
      // (`.label:` child present).
      if (firstArgNode.namedChildren.some((c) => c.type === 'value_argument_label')) continue;
      // Dedupe against pattern A by node position.
      if (seen.has(pathNode.startIndex)) continue;
      seen.add(pathNode.startIndex);
      const path = unquoteLiteral(pathNode.text);
      if (path === null) continue;
      out.push({
        role: 'consumer',
        framework: 'swift-verb-method',
        method: verbNode.text.toUpperCase(),
        path,
        name: null,
        confidence: 0.7,
      });
    }

    return out;
  },
};
