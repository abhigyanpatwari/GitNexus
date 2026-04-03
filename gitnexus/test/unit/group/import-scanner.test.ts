import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  scanFileForImports,
  scanRepoForImports,
} from '../../../src/core/group/extractors/import-scanner.js';

describe('import-scanner', () => {
  const targets = new Set(['@acme/shared', '@acme/ui-kit', 'simple-lib']);

  describe('scanFileForImports', () => {
    it('detects named ES imports', () => {
      const code = `import { formatDate, Logger } from '@acme/shared';`;
      const results = scanFileForImports(code, 'src/app.ts', targets);

      expect(results).toHaveLength(1);
      expect(results[0].packageName).toBe('@acme/shared');
      expect(results[0].importedSymbols).toEqual(['formatDate', 'Logger']);
      expect(results[0].isNamespaceImport).toBe(false);
      expect(results[0].isDefaultImport).toBe(false);
      expect(results[0].subpath).toBeUndefined();
    });

    it('detects default ES imports', () => {
      const code = `import SharedLib from '@acme/shared';`;
      const results = scanFileForImports(code, 'src/app.ts', targets);

      expect(results).toHaveLength(1);
      expect(results[0].packageName).toBe('@acme/shared');
      expect(results[0].isDefaultImport).toBe(true);
      expect(results[0].importedSymbols).toEqual([]);
    });

    it('detects default + named imports', () => {
      const code = `import SharedLib, { formatDate, Logger } from '@acme/shared';`;
      const results = scanFileForImports(code, 'src/app.ts', targets);

      expect(results).toHaveLength(1);
      expect(results[0].isDefaultImport).toBe(true);
      expect(results[0].importedSymbols).toEqual(['formatDate', 'Logger']);
    });

    it('detects namespace imports', () => {
      const code = `import * as Shared from '@acme/shared';`;
      const results = scanFileForImports(code, 'src/app.ts', targets);

      expect(results).toHaveLength(1);
      expect(results[0].packageName).toBe('@acme/shared');
      expect(results[0].isNamespaceImport).toBe(true);
      expect(results[0].importedSymbols).toEqual([]);
    });

    it('detects side-effect imports', () => {
      const code = `import '@acme/shared';`;
      const results = scanFileForImports(code, 'src/app.ts', targets);

      expect(results).toHaveLength(1);
      expect(results[0].packageName).toBe('@acme/shared');
      expect(results[0].importedSymbols).toEqual([]);
      expect(results[0].isDefaultImport).toBe(false);
    });

    it('detects re-exports', () => {
      const code = `export { formatDate } from '@acme/shared';`;
      const results = scanFileForImports(code, 'src/index.ts', targets);

      expect(results).toHaveLength(1);
      expect(results[0].packageName).toBe('@acme/shared');
    });

    it('detects CommonJS destructured require', () => {
      const code = `const { formatDate, Logger } = require('@acme/shared');`;
      const results = scanFileForImports(code, 'src/app.js', targets);

      expect(results).toHaveLength(1);
      expect(results[0].packageName).toBe('@acme/shared');
      expect(results[0].importedSymbols).toEqual(['formatDate', 'Logger']);
      expect(results[0].isDefaultImport).toBe(false);
    });

    it('detects CommonJS default require', () => {
      const code = `const shared = require('@acme/shared');`;
      const results = scanFileForImports(code, 'src/app.js', targets);

      expect(results).toHaveLength(1);
      expect(results[0].packageName).toBe('@acme/shared');
      expect(results[0].isDefaultImport).toBe(true);
      expect(results[0].importedSymbols).toEqual([]);
    });

    it('extracts subpath for scoped packages', () => {
      const code = `import { helper } from '@acme/shared/utils';`;
      const results = scanFileForImports(code, 'src/app.ts', targets);

      expect(results).toHaveLength(1);
      expect(results[0].packageName).toBe('@acme/shared');
      expect(results[0].subpath).toBe('/utils');
      expect(results[0].importedSymbols).toEqual(['helper']);
    });

    it('extracts subpath for unscoped packages', () => {
      const code = `import { helper } from 'simple-lib/utils/helpers';`;
      const results = scanFileForImports(code, 'src/app.ts', targets);

      expect(results).toHaveLength(1);
      expect(results[0].packageName).toBe('simple-lib');
      expect(results[0].subpath).toBe('/utils/helpers');
    });

    it('ignores imports from non-target packages', () => {
      const code = `
import React from 'react';
import { useState } from 'react';
import lodash from 'lodash';
      `;
      const results = scanFileForImports(code, 'src/app.ts', targets);
      expect(results).toHaveLength(0);
    });

    it('ignores relative imports', () => {
      const code = `
import { foo } from './utils';
import { bar } from '../shared';
      `;
      const results = scanFileForImports(code, 'src/app.ts', targets);
      expect(results).toHaveLength(0);
    });

    it('handles aliased imports (as keyword)', () => {
      const code = `import { formatDate as fmt, Logger as Log } from '@acme/shared';`;
      const results = scanFileForImports(code, 'src/app.ts', targets);

      expect(results).toHaveLength(1);
      // We keep the original name, not the alias
      expect(results[0].importedSymbols).toEqual(['formatDate', 'Logger']);
    });

    it('handles type-only imports', () => {
      const code = `import type { Config } from '@acme/shared';`;
      const results = scanFileForImports(code, 'src/app.ts', targets);

      expect(results).toHaveLength(1);
      expect(results[0].packageName).toBe('@acme/shared');
    });

    it('handles inline type imports', () => {
      const code = `import { type Config, formatDate } from '@acme/shared';`;
      const results = scanFileForImports(code, 'src/app.ts', targets);

      expect(results).toHaveLength(1);
      expect(results[0].importedSymbols).toEqual(['Config', 'formatDate']);
    });

    it('handles multiple imports from different packages', () => {
      const code = `
import { formatDate } from '@acme/shared';
import { Button } from '@acme/ui-kit';
import React from 'react';
      `;
      const results = scanFileForImports(code, 'src/app.ts', targets);

      expect(results).toHaveLength(2);
      expect(results[0].packageName).toBe('@acme/shared');
      expect(results[1].packageName).toBe('@acme/ui-kit');
    });

    it('handles multiple imports from the same package', () => {
      const code = `
import { formatDate } from '@acme/shared';
import { Logger } from '@acme/shared/logging';
      `;
      const results = scanFileForImports(code, 'src/app.ts', targets);

      expect(results).toHaveLength(2);
      expect(results[0].subpath).toBeUndefined();
      expect(results[1].subpath).toBe('/logging');
    });

    it('handles single-quoted imports', () => {
      const code = `import { Foo } from '@acme/shared';`;
      const results = scanFileForImports(code, 'src/app.ts', targets);
      expect(results).toHaveLength(1);
    });

    it('handles double-quoted imports', () => {
      const code = `import { Foo } from "@acme/shared";`;
      const results = scanFileForImports(code, 'src/app.ts', targets);
      expect(results).toHaveLength(1);
    });

    it('returns empty for empty file', () => {
      const results = scanFileForImports('', 'src/empty.ts', targets);
      expect(results).toHaveLength(0);
    });
  });

  describe('scanRepoForImports', () => {
    let tmpDir: string;

    beforeEach(() => {
      tmpDir = path.join(os.tmpdir(), `gitnexus-import-scan-${Date.now()}`);
      fs.mkdirSync(tmpDir, { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    function writeFile(relPath: string, content: string): void {
      const full = path.join(tmpDir, relPath);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }

    it('scans all source files recursively', async () => {
      writeFile('src/app.ts', `import { formatDate } from '@acme/shared';`);
      writeFile('src/utils/helper.ts', `import { Logger } from '@acme/shared';`);

      const results = await scanRepoForImports(tmpDir, targets);
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.filePath).sort()).toEqual([
        'src/app.ts',
        'src/utils/helper.ts',
      ]);
    });

    it('ignores node_modules', async () => {
      writeFile('node_modules/@acme/other/index.ts', `import { Foo } from '@acme/shared';`);
      writeFile('src/app.ts', `import { Bar } from '@acme/shared';`);

      const results = await scanRepoForImports(tmpDir, targets);
      expect(results).toHaveLength(1);
      expect(results[0].filePath).toBe('src/app.ts');
    });

    it('returns empty for empty target set', async () => {
      writeFile('src/app.ts', `import { Foo } from '@acme/shared';`);
      const results = await scanRepoForImports(tmpDir, new Set());
      expect(results).toHaveLength(0);
    });

    it('handles .js, .jsx, .tsx, .mjs, .cjs files', async () => {
      writeFile('src/a.js', `const { Foo } = require('@acme/shared');`);
      writeFile('src/b.jsx', `import { Bar } from '@acme/shared';`);
      writeFile('src/c.tsx', `import { Baz } from '@acme/shared';`);
      writeFile('src/d.mjs', `import { Qux } from '@acme/shared';`);
      writeFile('src/e.cjs', `const { Quux } = require('@acme/shared');`);

      const results = await scanRepoForImports(tmpDir, targets);
      expect(results).toHaveLength(5);
    });

    it('ignores non-JS files', async () => {
      writeFile('src/readme.md', `import { Foo } from '@acme/shared';`);
      writeFile('src/config.yaml', `import { Foo } from '@acme/shared';`);

      const results = await scanRepoForImports(tmpDir, targets);
      expect(results).toHaveLength(0);
    });
  });
});
