/**
 * Custom ESLint rule: require `parseSourceSafe(parser, content, ...)` instead
 * of direct `<parser>.parse(<content>, ...)` calls.
 *
 * Background: tree-sitter's Node.js native binding crashes with SIGSEGV on
 * Windows when handed a JS string longer than 32 767 chars. The crash happens
 * inside the binding's V8 string-to-buffer conversion and cannot be intercepted
 * by JavaScript `try/catch`. `parseSourceSafe` (in
 * `gitnexus/src/core/tree-sitter/safe-parse.ts`) routes large inputs through
 * the chunked-callback overload of `parser.parse(input, ...)` which bypasses
 * the broken conversion path. PR #1433 fixed every direct call site at the
 * time; this rule prevents new direct calls from creeping in.
 *
 * The rule is auto-fixable for the call-site rewrite. It does NOT auto-add the
 * import (computing the correct relative path per file is brittle); after the
 * call rewrite runs, the consumer file's `tsc` will complain about an
 * undefined identifier and the developer adds the import. This is the same
 * tradeoff `unused-imports/no-unused-imports` makes in the opposite direction.
 *
 * False-positive suppression:
 * - Skips calls whose receiver is a known non-tree-sitter library (`JSON`,
 *   `URL`, `marked`, `Number`).
 * - Skips calls whose first argument is a string-literal (grammar-load smoke
 *   tests like `_testParser.parse('service X { rpc Y (R) returns (R); }')`).
 * - Skips test files (`.test.ts`/`.test.tsx`/`.spec.ts`).
 * - Skips the `safe-parse.ts` helper itself.
 */

const SKIPPED_RECEIVERS = new Set(['JSON', 'URL', 'marked', 'Number', 'Math']);

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require parseSourceSafe instead of direct tree-sitter `<parser>.parse(content, ...)` calls (Windows SIGSEGV protection)',
      recommended: true,
    },
    fixable: 'code',
    schema: [],
    messages: {
      useSafeParse:
        'Direct `{{receiver}}.parse(...)` can SIGSEGV on Windows for inputs > 32 767 chars (uncatchable from JS). Use `parseSourceSafe({{receiver}}, ...)` from `core/tree-sitter/safe-parse.js`. Auto-fix rewrites the call; add the missing import yourself.',
    },
  },
  create(context) {
    const filename = context.filename ?? context.getFilename();
    // Don't lint the helper itself or test files.
    if (filename.includes('safe-parse')) return {};
    if (/[.](?:test|spec)\.tsx?$/.test(filename)) return {};

    const sourceCode = context.sourceCode ?? context.getSourceCode();

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression') return;
        if (callee.computed) return;
        if (callee.property.type !== 'Identifier') return;
        if (callee.property.name !== 'parse') return;

        // Skip known non-tree-sitter receivers.
        if (callee.object.type === 'Identifier' && SKIPPED_RECEIVERS.has(callee.object.name)) {
          return;
        }

        // Smoke tests pass a string literal directly; those are trivially safe.
        const firstArg = node.arguments[0];
        if (!firstArg) return;
        if (firstArg.type === 'Literal' && typeof firstArg.value === 'string') return;
        if (firstArg.type === 'TemplateLiteral' && firstArg.expressions.length === 0) return;

        const receiverText = sourceCode.getText(callee.object);
        // Receiver-text-shape skip: anything matching well-known JS APIs that
        // happen to have a `.parse(<expr>)` shape but aren't tree-sitter.
        if (
          /^(JSON|URL|marked|Number|Math|Date|globalThis\.JSON)\b/.test(receiverText) ||
          /\bjson\.parse\b/i.test(receiverText)
        ) {
          return;
        }

        context.report({
          node,
          messageId: 'useSafeParse',
          data: { receiver: receiverText },
          fix(fixer) {
            const argsText = node.arguments.map((arg) => sourceCode.getText(arg)).join(', ');
            return fixer.replaceText(node, `parseSourceSafe(${receiverText}, ${argsText})`);
          },
        });
      },
    };
  },
};
