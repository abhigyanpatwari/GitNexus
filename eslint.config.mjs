import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import unusedImports from 'eslint-plugin-unused-imports';
import reactHooks from 'eslint-plugin-react-hooks';
import prettierConfig from 'eslint-config-prettier';

// Selectors that protect MCP-reachable code from corrupting the JSON-RPC
// stdio frame stream. The MCP-reachable block below uses these directly;
// the lbug-adapter file-specific block must spread them in too because
// ESLint flat config REPLACES (not merges) `no-restricted-syntax` when
// multiple matching configs target the same file. Extracting to a const
// makes the dependency mechanical instead of documentation-enforced.
const mcpStdoutWriteSelectors = [
  {
    selector:
      "MemberExpression[object.type='MemberExpression'][object.object.name='process'][object.property.name='stdout'][property.name='write']",
    message:
      'Direct process.stdout.write is forbidden in MCP-reachable code. Route diagnostics through console.error or process.stderr.write — the MCP stdio transport owns stdout for JSON-RPC frames.',
  },
  {
    selector:
      "CallExpression[callee.type='MemberExpression'][callee.object.type='MemberExpression'][callee.object.object.name='process'][callee.object.property.name='stdout'][callee.property.name='write']",
    message:
      'Direct process.stdout.write is forbidden in MCP-reachable code. Route diagnostics through console.error or process.stderr.write — the MCP stdio transport owns stdout for JSON-RPC frames.',
  },
  {
    // Catches the canonical destructuring shape:
    //   const { write } = process.stdout;
    // (and any other ObjectPattern destructure rooted at process.stdout)
    // which would otherwise capture a reference to the original write
    // and bypass the sentinel.
    selector:
      "VariableDeclarator[init.type='MemberExpression'][init.object.name='process'][init.property.name='stdout'] > ObjectPattern",
    message:
      'Destructuring process.stdout is forbidden in MCP-reachable code — bypasses the sentinel. Use process.stderr.write for diagnostics.',
  },
];

export default [
  // Global ignores
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/coverage/**',
      'gitnexus/vendor/**',
      'gitnexus-web/src/vendor/**',
      'gitnexus/test/fixtures/**',
      'gitnexus-web/test/fixtures/**',
      'gitnexus-web/playwright-report/**',
      'gitnexus-web/test-results/**',
      '**/*.d.ts',
      '.claude/**',
      '.history/**',
    ],
  },

  // Base TypeScript config for all packages
  {
    files: ['**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
      'unused-imports': unusedImports,
    },
    rules: {
      // Unused imports — auto-fixable
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'warn',
        { vars: 'all', varsIgnorePattern: '^_', args: 'after-used', argsIgnorePattern: '^_' },
      ],

      // TypeScript quality
      '@typescript-eslint/no-unused-vars': 'off', // handled by unused-imports plugin
      'no-unused-vars': 'off', // handled by unused-imports plugin
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-non-null-assertion': 'warn',

      // General quality
      'no-debugger': 'error',
      'prefer-const': 'error',
      'no-var': 'error',
      eqeqeq: ['error', 'always', { null: 'ignore' }],
    },
  },

  // CLI/server packages — `console.log` IS the contract (CLI tool data output
  // on stdout, e.g. `gitnexus query | jq`; server pretty-printed banners).
  // Diagnostic logging (`warn`/`error`/`debug`/`info`) goes through pino like
  // the rest of the codebase.
  {
    files: ['gitnexus/src/cli/**/*.ts', 'gitnexus/src/server/**/*.ts'],
    rules: {
      'no-console': ['error', { allow: ['log'] }],
    },
  },

  // Forcing function for the pino migration. Severity is `error` — the
  // codebase-wide migration is complete; new `console.*` in core source
  // must fail lint. CLI/server are exempt above (legitimate stdout output).
  // Tests, bin scripts, and the logger module itself remain exempt.
  {
    files: ['gitnexus/src/**/*.ts'],
    ignores: ['gitnexus/src/cli/**', 'gitnexus/src/server/**', 'gitnexus/src/core/logger.ts'],
    rules: {
      'no-console': 'error',
    },
  },

  // MCP-reachable code: forbid stdout-corrupting writes. The MCP stdio
  // transport writes JSON-RPC frames to stdout; per the spec, the server
  // MUST NOT write anything to stdout that is not a valid MCP message.
  // Diagnostics must go to stderr (console.error). Direct process.stdout.write
  // bypasses the gate and is also forbidden in these dirs.
  // cli/mcp.ts is included here even though it lives under cli/ — it is the
  // MCP entrypoint and inherits stricter discipline than the rest of cli/.
  {
    files: [
      'gitnexus/src/mcp/**/*.ts',
      'gitnexus/src/core/lbug/**/*.ts',
      'gitnexus/src/core/embeddings/**/*.ts',
      'gitnexus/src/core/tree-sitter/**/*.ts',
      'gitnexus/src/cli/mcp.ts',
    ],
    rules: {
      'no-console': ['error', { allow: ['error'] }],
      'no-restricted-syntax': ['error', ...mcpStdoutWriteSelectors],
    },
  },

  // React-specific rules for gitnexus-web
  {
    files: ['gitnexus-web/src/**/*.{ts,tsx}'],
    plugins: {
      'react-hooks': reactHooks,
    },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
    },
  },

  // Prevent direct conn.close() / db.close() in the LadybugDB adapter (#1376).
  // All close operations must go through safeClose() so the WAL is always
  // flushed before the connection is released. The sole authorised call site
  // inside safeClose itself uses an eslint-disable-next-line override.
  //
  // ESLint flat config REPLACES (not merges) `no-restricted-syntax` when
  // multiple matching configs target the same file. lbug-adapter.ts is also
  // covered by the MCP-reachable block above, so we spread the shared
  // mcpStdoutWriteSelectors here alongside the safeClose selectors. Without
  // this, lbug-adapter would silently lose its MCP stdout-write protection.
  {
    files: ['gitnexus/src/core/lbug/lbug-adapter.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...mcpStdoutWriteSelectors,
        {
          selector: "CallExpression[callee.object.name='conn'][callee.property.name='close']",
          message: 'Use safeClose() instead of calling conn.close() directly (#1376).',
        },
        {
          selector: "CallExpression[callee.object.name='db'][callee.property.name='close']",
          message: 'Use safeClose() instead of calling db.close() directly (#1376).',
        },
      ],
    },
  },

  // Disable formatting rules (prettier handles those)
  prettierConfig,
];
