import type Parser from 'tree-sitter';
import { requireVendoredGrammar } from '../../../tree-sitter/vendored-grammars.js';
import { compilePatterns, runCompiledPatterns } from '../tree-sitter-scanner.js';
import type { HttpDetection, HttpLanguagePlugin } from './types.js';

/**
 * Swift HTTP plugin (consumers only, #1677).
 *
 * iOS / macOS apps and Swift-on-server clients almost never call
 * `URLSession` directly at each call site; they go through a thin wrapper
 * or Alamofire. This plugin covers the two dominant shapes:
 *
 *   1. Verb-named wrapper methods on a receiver:
 *        client.get("/api/users")
 *        try await api.post(path: "/api/orders", body: data)
 *        Client.delete(url: "\(baseURL)/api/items/\(id)")
 *      The verb is the method name (`get`/`post`/`put`/`patch`/`delete`);
 *      the path is the FIRST argument when unlabeled, or the argument
 *      labeled `path:` / `url:` anywhere in the list.
 *
 *   2. Alamofire-style `request`:
 *        AF.request("https://api.example.com/v1/items", method: .post)
 *      The path is the first argument; the verb comes from `method:`
 *      (`.post`, `HTTPMethod.post`, `"POST"`). No `method:` argument means
 *      GET only on `AF` (Alamofire's default); on any other receiver the
 *      default is the wrapper's own and unknown, so it is `*`. A `method:` the scan cannot read
 *      statically (a variable) yields the wildcard `*`, which the matcher
 *      pairs with a provider of any verb on the same path.
 *
 * String interpolation `\(expr)` becomes a `${expr}` placeholder, the
 * form the orchestrator's consumer-path normalizer already folds into
 * `{param}` (and strips when it is a leading base-URL prefix).
 *
 * Because `get`/`post`/`request` are common method names, a detection is
 * emitted only when the literal looks like a URL path: it starts with
 * `/`, `http(s)://`, or an interpolated base followed by `/`. That keeps
 * `cache.get("userKey")` and similar out.
 *
 * Out of scope (needs data-flow the source scan does not have):
 *   - `var request = URLRequest(url: ...); request.httpMethod = "POST"`
 *   - bare `URLSession.shared.data(from: URL(string: "...")!)`
 *   - paths held in variables or constants rather than literals.
 *
 * tree-sitter-swift is a vendored grammar; when its native binding is
 * unavailable the plugin exports `null` and `index.ts` skips `.swift`.
 *
 * AST shape (tree-sitter-swift):
 *   call_expression
 *     navigation_expression
 *       target: <receiver>
 *       suffix: navigation_suffix  suffix: simple_identifier   ← verb / `request`
 *     call_suffix
 *       value_arguments
 *         value_argument  (name: value_argument_label)?  value: line_string_literal
 */

let Swift: Parser.Language | null = null;
try {
  Swift = requireVendoredGrammar('tree-sitter-swift');
} catch {
  Swift = null;
}

const VERB_TO_HTTP: Record<string, string> = {
  get: 'GET',
  post: 'POST',
  put: 'PUT',
  patch: 'PATCH',
  delete: 'DELETE',
};

const PATH_LABELS = new Set(['path', 'url']);

/** Receivers known to be Alamofire's global session, whose `request` defaults to GET. */
const ALAMOFIRE_RECEIVERS = new Set(['AF', 'Alamofire.AF']);

const CALL_PATTERNS = Swift
  ? compilePatterns({
      name: 'swift-http-calls',
      language: Swift,
      patterns: [
        {
          meta: {},
          query: `
            (call_expression
              (navigation_expression
                target: (_) @recv
                suffix: (navigation_suffix suffix: (simple_identifier) @fn))
              (call_suffix (value_arguments) @args)) @call
          `,
        },
      ],
    })
  : null;

/** Label of a `value_argument`, or null when it is positional. */
function argLabel(arg: Parser.SyntaxNode): string | null {
  return arg.childForFieldName('name')?.text ?? null;
}

/**
 * Text of a single-line string literal with each `\(expr)` replaced by a
 * `${expr}` placeholder. Null for anything that is not a plain
 * `line_string_literal` (variables, concatenations, multi-line strings).
 */
function swiftStringLiteral(node: Parser.SyntaxNode | null | undefined): string | null {
  if (!node || node.type !== 'line_string_literal') return null;
  let out = '';
  for (const part of node.namedChildren) {
    if (part.type === 'interpolated_expression') out += '${p}';
    else out += part.text;
  }
  return out;
}

function looksLikeUrlPath(s: string): boolean {
  return /^(?:\/|https?:\/\/|(?:\$\{p\})+\/)/i.test(s);
}

/** `.post` / `HTTPMethod.post` / `"POST"` → `POST`; anything else → `*`. */
function readMethodArg(value: Parser.SyntaxNode | null | undefined): string {
  if (!value) return '*';
  let name: string | null | undefined = null;
  if (value.type === 'prefix_expression') {
    name = value.childForFieldName('target')?.text;
  } else if (value.type === 'navigation_expression') {
    name = value.childForFieldName('suffix')?.childForFieldName('suffix')?.text;
  } else {
    name = swiftStringLiteral(value);
  }
  return (name && VERB_TO_HTTP[name.toLowerCase()]) ?? '*';
}

export const SWIFT_HTTP_PLUGIN: HttpLanguagePlugin | null =
  Swift && CALL_PATTERNS
    ? {
        name: 'swift-http',
        language: Swift,
        scan(tree) {
          const out: HttpDetection[] = [];
          for (const match of runCompiledPatterns(CALL_PATTERNS, tree)) {
            const fn = match.captures.fn?.text;
            const argsNode = match.captures.args;
            if (!fn || !argsNode) continue;
            const args = argsNode.namedChildren.filter((n) => n.type === 'value_argument');
            if (args.length === 0) continue;

            let method: string;
            let framework: string;
            if (fn === 'request') {
              const methodArg = args.find((a) => argLabel(a) === 'method');
              // GET is Alamofire's default only; a custom `request` wrapper's
              // default verb is unknown, so it stays a wildcard.
              const isAlamofire = ALAMOFIRE_RECEIVERS.has(match.captures.recv?.text ?? '');
              method = methodArg
                ? readMethodArg(methodArg.childForFieldName('value'))
                : isAlamofire
                  ? 'GET'
                  : '*';
              framework = 'swift-request';
            } else if (VERB_TO_HTTP[fn]) {
              method = VERB_TO_HTTP[fn];
              framework = 'swift-wrapper';
            } else {
              continue;
            }

            // First positional argument, else the first `path:` / `url:` one.
            const pathArg =
              argLabel(args[0]) === null
                ? args[0]
                : args.find((a) => PATH_LABELS.has(argLabel(a) ?? ''));
            const pathNode = pathArg?.childForFieldName('value');
            const path = swiftStringLiteral(pathNode);
            if (!pathNode || path === null || !looksLikeUrlPath(path)) continue;

            out.push({
              role: 'consumer',
              framework,
              method,
              path,
              name: null,
              // Call site, per the HttpDetection.line contract; differs from the
              // path literal's line when arguments wrap onto later lines.
              line: (match.captures.call ?? pathNode).startPosition.row + 1,
              confidence: 0.7,
            });
          }
          return out;
        },
      }
    : null;
