import tsPlugin from '@typescript-eslint/eslint-plugin';
import tsParser from '@typescript-eslint/parser';
import unusedImports from 'eslint-plugin-unused-imports';
import reactHooks from 'eslint-plugin-react-hooks';
import prettierConfig from 'eslint-config-prettier';

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

  // CLI package — allow console.log (it's a CLI tool)
  {
    files: ['gitnexus/src/cli/**/*.ts', 'gitnexus/src/server/**/*.ts'],
    rules: {
      'no-console': 'off',
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
      'no-restricted-syntax': [
        'error',
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
      ],
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
  {
    files: ['gitnexus/src/core/lbug/lbug-adapter.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
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
