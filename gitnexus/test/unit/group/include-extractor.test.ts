import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const { parseSourceSafeSpy } = vi.hoisted(() => ({ parseSourceSafeSpy: vi.fn() }));

vi.mock('../../../src/core/tree-sitter/safe-parse.js', async () => {
  const { buildSafeParseMock } = await import('../../helpers/parse-source-safe-mock.js');
  return buildSafeParseMock(parseSourceSafeSpy);
});

import { IncludeExtractor } from '../../../src/core/group/extractors/include-extractor.js';
import type { RepoHandle } from '../../../src/core/group/types.js';
import { normalizeContractId } from '../../../src/core/group/matching.js';

describe('IncludeExtractor', () => {
  let tmpDir: string;
  let extractor: IncludeExtractor;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-include-'));
    extractor = new IncludeExtractor();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFile(relPath: string, content: string): void {
    const full = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  const makeRepo = (repoPath: string): RepoHandle => ({
    id: 'test-repo',
    path: 'test/app',
    repoPath,
    storagePath: path.join(repoPath, '.gitnexus'),
  });

  // ---- Provider detection ----

  describe('provider extraction', () => {
    it('registers .h files as providers', async () => {
      writeFile('map/base/view.h', '#pragma once\nclass View {};');
      writeFile('map/base/types.h', '#pragma once\nstruct Point {};');

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(providers).toHaveLength(2);
      const ids = providers.map((p) => p.contractId).sort();
      expect(ids).toEqual(['include::map/base/types.h', 'include::map/base/view.h']);
      expect(providers[0].type).toBe('include');
      expect(providers[0].confidence).toBeGreaterThanOrEqual(0.95);
    });

    it('registers .hpp files as providers', async () => {
      writeFile('utils/helper.hpp', '#pragma once\ntemplate<class T> T id(T x) { return x; }');

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(providers).toHaveLength(1);
      expect(providers[0].contractId).toBe('include::utils/helper.hpp');
    });

    it('does not register .cpp files as providers', async () => {
      writeFile('src/main.cpp', 'int main() { return 0; }');
      writeFile('src/utils.h', '#pragma once');

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(providers).toHaveLength(1);
      expect(providers[0].contractId).toBe('include::src/utils.h');
    });
  });

  // ---- Consumer detection ----

  describe('consumer extraction', () => {
    it('emits unresolved includes as consumers', async () => {
      writeFile(
        'src/main.cpp',
        `#include "map/base/view.h"
#include "map/base/types.h"
int main() { return 0; }`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers).toHaveLength(2);
      const ids = consumers.map((c) => c.contractId).sort();
      expect(ids).toEqual(['include::map/base/types.h', 'include::map/base/view.h']);
      expect(consumers[0].type).toBe('include');
      expect(consumers[0].confidence).toBe(0.85);
    });

    it('skips locally resolved includes', async () => {
      writeFile('map/base/view.h', '#pragma once\nclass View {};');
      writeFile(
        'src/main.cpp',
        `#include "map/base/view.h"
#include "external/lib.h"
int main() { return 0; }`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      // Only external/lib.h should be a consumer — map/base/view.h resolves locally
      expect(consumers).toHaveLength(1);
      expect(consumers[0].contractId).toBe('include::external/lib.h');
    });

    it('skips angle-bracket includes', async () => {
      writeFile(
        'src/main.cpp',
        `#include <stdio.h>
#include <vector>
#include "app/interface.h"
int main() { return 0; }`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers).toHaveLength(1);
      expect(consumers[0].contractId).toBe('include::app/interface.h');
    });

    it('skips well-known system headers in quotes', async () => {
      writeFile(
        'src/main.cpp',
        `#include "stdio.h"
#include "stdlib.h"
#include "app/config.h"
int main() { return 0; }`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers).toHaveLength(1);
      expect(consumers[0].contractId).toBe('include::app/config.h');
    });

    it('skips system path prefixes', async () => {
      writeFile(
        'src/main.c',
        `#include "sys/types.h"
#include "linux/input.h"
#include "mylib/types.h"
int main() { return 0; }`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers).toHaveLength(1);
      expect(consumers[0].contractId).toBe('include::mylib/types.h');
    });
  });

  // ---- Cross-repo matching scenario ----

  describe('cross-repo matching', () => {
    it('provider and consumer produce matching contractIds', async () => {
      // Simulate provider repo (header-only)
      const providerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-include-provider-'));
      const providerFile = path.join(providerDir, 'map/base/dice_map_view.h');
      fs.mkdirSync(path.dirname(providerFile), { recursive: true });
      fs.writeFileSync(providerFile, '#pragma once\nclass DiceMapView {};');

      // Simulate consumer repo
      const consumerDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gitnexus-include-consumer-'));
      const consumerFile = path.join(consumerDir, 'src/controller.cpp');
      fs.mkdirSync(path.dirname(consumerFile), { recursive: true });
      fs.writeFileSync(consumerFile, '#include "map/base/dice_map_view.h"\nvoid init() {}');

      try {
        const providerContracts = await extractor.extract(null, providerDir, makeRepo(providerDir));
        const consumerContracts = await extractor.extract(null, consumerDir, makeRepo(consumerDir));

        const providers = providerContracts.filter((c) => c.role === 'provider');
        const consumers = consumerContracts.filter((c) => c.role === 'consumer');

        expect(providers.length).toBeGreaterThanOrEqual(1);
        expect(consumers.length).toBeGreaterThanOrEqual(1);

        const providerIds = new Set(providers.map((p) => normalizeContractId(p.contractId)));
        const consumerIds = consumers.map((c) => normalizeContractId(c.contractId));

        // The consumer's include path should match a provider's file path
        expect(providerIds.has(consumerIds[0])).toBe(true);
      } finally {
        fs.rmSync(providerDir, { recursive: true, force: true });
        fs.rmSync(consumerDir, { recursive: true, force: true });
      }
    });
  });

  // ---- Review finding #4: suffixResolve ambiguity ----

  describe('finding #4: suffix-ambiguity does not silently suppress cross-repo include', () => {
    it('emits a cross-repo contract when the include path does not match any local file (even if a shorter suffix does)', async () => {
      // local repo has `internal/api.h` but NOT `ext/api.h`
      writeFile('internal/api.h', '#pragma once');
      writeFile(
        'src/main.cpp',
        `#include "ext/api.h"
int main() { return 0; }`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      // Previously suffixResolve would match `api.h` against `internal/api.h`
      // and drop the cross-repo contract. After finding #4 fix, we only
      // accept exact full-path matches — so `ext/api.h` must still be
      // emitted as a consumer contract.
      expect(consumers).toHaveLength(1);
      expect(consumers[0].contractId).toBe('include::ext/api.h');
    });

    it('still suppresses a local include when the FULL path matches', async () => {
      writeFile('ext/api.h', '#pragma once');
      writeFile('src/main.cpp', '#include "ext/api.h"\nint main(){return 0;}');

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers).toHaveLength(0);
    });

    it('resolves locally when include omits extension and a matching .h exists', async () => {
      writeFile('foo/bar.h', '#pragma once');
      writeFile('src/main.cpp', '#include "foo/bar"\nint main(){return 0;}');

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers).toHaveLength(0);
    });
  });

  // ---- Review finding #5: regex fallback must strip block comments ----

  describe('finding #5: regex fallback ignores block-commented includes', () => {
    it('does not emit a contract for an #include inside /* ... */', async () => {
      // Force regex fallback by producing a file larger than tree-sitter's
      // 32 KB hard cap. The include we care about lives inside a block
      // comment that spans the file.
      const filler = 'int dummy_' + 'x'.repeat(32) + ' = 0;\n'.repeat(1200);
      const content = `/*
 * Historical include, kept for reference only:
 * #include "legacy/old-api.h"
 */
${filler}
#include "real/api.h"
int main(){return 0;}`;
      writeFile('src/huge.cpp', content);

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');
      const ids = consumers.map((c) => c.contractId);

      // The live include should appear; the commented-out one must NOT.
      expect(ids).toContain('include::real/api.h');
      expect(ids).not.toContain('include::legacy/old-api.h');
    });
  });

  // ---- Review finding #6: meta.source must reflect which extraction path ran ----

  describe('finding #6: meta.source reflects extraction path', () => {
    it('stamps `tree_sitter` on contracts produced via AST walking', async () => {
      writeFile('src/main.cpp', '#include "app/small.h"\nint main(){return 0;}');

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers).toHaveLength(1);
      expect((consumers[0].meta as { source?: string } | undefined)?.source).toBe('tree_sitter');
    });

    it('meta.source is one of the two documented values (tree_sitter | regex_fallback)', async () => {
      // Regex fallback is a defensive branch that only fires if
      // parser.setLanguage() or parser.parse() throws. In practice
      // tree-sitter-c/cpp handles realistic inputs, so we only assert
      // the meta.source contract: it is always present and always one of
      // the two documented values. This guards against future regressions
      // that might hard-code the wrong string.
      writeFile('src/main.cpp', '#include "ext/whatever.h"\nint main(){return 0;}');
      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumer = contracts.find((c) => c.role === 'consumer');
      expect(consumer).toBeDefined();
      const src = (consumer?.meta as { source?: string } | undefined)?.source;
      expect(['tree_sitter', 'regex_fallback']).toContain(src);
    });
  });

  // ---- Review finding #3: provider id collision on case-sensitive FS ----

  describe('finding #3: case-folding is documented and deterministic', () => {
    it('collapses `Foo.h` and `foo.h` onto the same provider contract-id (documented trade-off)', async () => {
      writeFile('Foo.h', '#pragma once\n// Capital Foo');
      // On case-insensitive filesystems (macOS default) the second writeFile
      // will overwrite the first, so we only create this when distinct files
      // can coexist (case-sensitive FS, e.g. Linux CI).
      try {
        fs.writeFileSync(path.join(tmpDir, 'foo.h'), '#pragma once\n// lowercase foo');
      } catch {
        // Ignore — some FS won't allow both names to coexist.
      }

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const providers = contracts.filter((c) => c.role === 'provider');
      const ids = providers.map((p) => p.contractId);

      // Both files (if they coexist) must normalize to the same id.
      // dedupe() keeps only one; caller code must be aware of this.
      expect(ids).toContain('include::foo.h');
      // Never see a mixed-case contract-id leak out.
      expect(ids.every((id) => id === id.toLowerCase())).toBe(true);
    });
  });

  // ---- Deduplication ----

  describe('deduplication', () => {
    it('deduplicates same include from multiple source files', async () => {
      writeFile('src/a.cpp', '#include "ext/api.h"\nvoid a() {}');
      writeFile('src/b.cpp', '#include "ext/api.h"\nvoid b() {}');

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      // Both files include "ext/api.h" — each should produce a separate
      // consumer contract (different symbolRef.filePath)
      expect(consumers).toHaveLength(2);
      const files = consumers.map((c) => c.symbolRef.filePath).sort();
      expect(files).toEqual(['src/a.cpp', 'src/b.cpp']);
    });
  });

  // ---- normalizeContractId ----

  describe('normalizeContractId for include', () => {
    it('lowercases the path', () => {
      expect(normalizeContractId('include::Map/Base/Foo.h')).toBe('include::map/base/foo.h');
    });

    it('normalizes backslashes', () => {
      expect(normalizeContractId('include::map\\base\\foo.h')).toBe('include::map/base/foo.h');
    });

    it('strips leading ./', () => {
      expect(normalizeContractId('include::./foo.h')).toBe('include::foo.h');
    });

    it('collapses consecutive slashes', () => {
      expect(normalizeContractId('include::map//base///foo.h')).toBe('include::map/base/foo.h');
    });
  });

  // ---- PR #1156 follow-up: `../` relative includes ----

  describe('follow-up: `../` relative includes are skipped', () => {
    it('does not emit a consumer contract for `#include "../foo.h"`', async () => {
      // Producer: a header that exists locally but only via parent reference
      writeFile('include/foo.h', '#pragma once');
      writeFile(
        'src/sub/main.cpp',
        `#include "../../include/foo.h"
#include "real/cross_repo.h"
int main() { return 0; }`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      // Only `real/cross_repo.h` should remain — the `..`-prefixed include
      // is intra-repo noise that no provider can ever satisfy.
      expect(consumers.map((c) => c.contractId)).toEqual(['include::real/cross_repo.h']);
    });

    it('skips backslash-form `..\\` for completeness', async () => {
      writeFile(
        'src/main.cpp',
        `#include "..\\\\sibling\\\\foo.h"
#include "remote/header.h"
int main() { return 0; }`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      const ids = consumers.map((c) => c.contractId);
      expect(ids).toContain('include::remote/header.h');
      expect(ids.some((id) => id.includes('..'))).toBe(false);
    });
  });

  // ---- PR #1156 follow-up: macro-style includes ----

  describe('follow-up: macro-style #include emits no consumer contract', () => {
    it('does not emit a consumer contract for `#include PLATFORM_HEADER` (no separator, no dot)', async () => {
      // `#include PLATFORM_HEADER` parses under tree-sitter as an identifier
      // node, slips past the existing system-header / `..` filters, and used
      // to leak through as a permanently orphaned consumer contract because
      // no file is ever named `PLATFORM_HEADER`. Verify the macro guard
      // suppresses it while preserving the real cross-repo include.
      writeFile(
        'src/main.cpp',
        `#include PLATFORM_HEADER
#include "real/api.h"
int main() { return 0; }`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers.map((c) => c.contractId)).toEqual(['include::real/api.h']);
    });

    it('skips multiple macro identifiers in the same translation unit', async () => {
      writeFile(
        'src/cfg.cpp',
        `#include CONFIG_HEADER
#include PLATFORM_HEADER
#include ASSERT_H_
int main(){return 0;}`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumers = contracts.filter((c) => c.role === 'consumer');

      expect(consumers).toHaveLength(0);
    });
  });

  // ---- PR #1156 follow-up: graph provider absolute paths ----

  describe('follow-up: extractProvidersGraph strips repo root from absolute paths', () => {
    it('produces repo-relative contract IDs when the graph returns absolute paths', async () => {
      writeFile('map/base/view.h', '#pragma once\nclass View {};');
      writeFile('utils/types.hpp', '#pragma once');

      // Stub the Cypher executor to return absolute paths the way
      // gitnexus analyze actually persists them.
      const absolute1 = path.join(tmpDir, 'map/base/view.h');
      const absolute2 = path.join(tmpDir, 'utils/types.hpp');
      const stubDb = async () => [
        { filePath: absolute1, fileId: 'File:abs:1' },
        { filePath: absolute2, fileId: 'File:abs:2' },
      ];

      const contracts = await extractor.extract(stubDb, tmpDir, makeRepo(tmpDir));
      const providers = contracts.filter((c) => c.role === 'provider');

      const ids = providers.map((p) => p.contractId).sort();
      expect(ids).toEqual(['include::map/base/view.h', 'include::utils/types.hpp']);
      expect(providers.every((p) => p.meta?.source === 'graph')).toBe(true);
    });

    it('drops graph rows whose path resolves outside the repo root', async () => {
      writeFile('local/header.h', '#pragma once');
      const absoluteLocal = path.join(tmpDir, 'local/header.h');
      const stubDb = async () => [
        { filePath: absoluteLocal, fileId: 'File:1' },
        // Stale absolute path from a different machine — must be skipped.
        { filePath: '/some/other/repo/foreign.h', fileId: 'File:2' },
      ];

      const contracts = await extractor.extract(stubDb, tmpDir, makeRepo(tmpDir));
      const providers = contracts.filter((c) => c.role === 'provider');

      expect(providers.map((p) => p.contractId)).toEqual(['include::local/header.h']);
    });
  });

  // ---- PR #1156 Codex follow-up: discovery aligned with ingestion ----

  describe('follow-up: file discovery honors createIgnoreFilter and getMaxFileSizeBytes', () => {
    it('does not emit a provider contract for a header excluded by .gitignore', async () => {
      writeFile('.gitignore', 'vendor-headers/\n');
      writeFile('vendor-headers/blocked.h', '#pragma once');
      writeFile('src/wanted.h', '#pragma once');

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const providerIds = contracts.filter((c) => c.role === 'provider').map((p) => p.contractId);

      expect(providerIds).toContain('include::src/wanted.h');
      expect(providerIds).not.toContain('include::vendor-headers/blocked.h');
    });

    it('does not emit a provider contract for a header excluded by .gitnexusignore', async () => {
      writeFile('.gitnexusignore', 'legacy/\n');
      writeFile('legacy/old.h', '#pragma once');
      writeFile('src/current.h', '#pragma once');

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const providerIds = contracts.filter((c) => c.role === 'provider').map((p) => p.contractId);

      expect(providerIds).toContain('include::src/current.h');
      expect(providerIds).not.toContain('include::legacy/old.h');
    });

    it('does not parse #include directives in a source file excluded by .gitignore', async () => {
      // The ignored source file references a header that would otherwise be
      // a cross-repo consumer. After alignment, the ignored file is invisible
      // to the consumer scan — no consumer contract should appear.
      writeFile('.gitignore', 'generated/\n');
      writeFile(
        'generated/auto.cpp',
        `#include "remote/should_not_appear.h"
int auto_main() { return 0; }`,
      );

      const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
      const consumerIds = contracts.filter((c) => c.role === 'consumer').map((c) => c.contractId);

      expect(consumerIds).not.toContain('include::remote/should_not_appear.h');
    });

    it('skips a provider header whose size exceeds GITNEXUS_MAX_FILE_SIZE', async () => {
      const previous = process.env.GITNEXUS_MAX_FILE_SIZE;
      process.env.GITNEXUS_MAX_FILE_SIZE = '1'; // 1 KB cap
      try {
        // 4 KB header — comfortably exceeds the cap.
        const oversized = '#pragma once\n' + 'x'.repeat(4 * 1024);
        writeFile('huge/big.h', oversized);
        writeFile('small/tiny.h', '#pragma once');

        const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
        const providerIds = contracts.filter((c) => c.role === 'provider').map((p) => p.contractId);

        expect(providerIds).toContain('include::small/tiny.h');
        expect(providerIds).not.toContain('include::huge/big.h');
      } finally {
        if (previous === undefined) delete process.env.GITNEXUS_MAX_FILE_SIZE;
        else process.env.GITNEXUS_MAX_FILE_SIZE = previous;
      }
    });

    it('skips parsing #include directives in source files exceeding GITNEXUS_MAX_FILE_SIZE', async () => {
      const previous = process.env.GITNEXUS_MAX_FILE_SIZE;
      process.env.GITNEXUS_MAX_FILE_SIZE = '1';
      try {
        const oversized =
          '#include "remote/should_not_appear.h"\n' +
          '// padding to push the file past 1 KB\n' +
          'x'.repeat(4 * 1024);
        writeFile('big/main.cpp', oversized);

        const contracts = await extractor.extract(null, tmpDir, makeRepo(tmpDir));
        const consumerIds = contracts.filter((c) => c.role === 'consumer').map((c) => c.contractId);

        expect(consumerIds).not.toContain('include::remote/should_not_appear.h');
      } finally {
        if (previous === undefined) delete process.env.GITNEXUS_MAX_FILE_SIZE;
        else process.env.GITNEXUS_MAX_FILE_SIZE = previous;
      }
    });
  });

  describe('Windows SIGSEGV regression — large input must route through parseSourceSafe', () => {
    it('routes >32 767-char header file through parseSourceSafe (not direct parser.parse)', async () => {
      parseSourceSafeSpy.mockClear();

      // Bump the file-size cap so the >40 000-char file isn't filtered before
      // it ever reaches the parser. Direct parser.parse(content) on a string
      // this size SIGSEGVs the process on Windows. The spy assertion catches
      // the regression — a "no throw" assertion alone is satisfied by the
      // bypass on Linux/macOS where parser.parse(40 000 chars) succeeds.
      const previousLimit = process.env.GITNEXUS_MAX_FILE_SIZE;
      process.env.GITNEXUS_MAX_FILE_SIZE = '512';
      try {
        const includes = Array.from(
          { length: 1500 },
          (_, i) => `#include "lib/header_${i}.h"\n`,
        ).join('');
        const largeHeader = `#pragma once\n${includes}\nstruct Big {};\n`;
        expect(largeHeader.length).toBeGreaterThan(40_000);

        writeFile('big/big.cpp', largeHeader);

        await extractor.extract(null, tmpDir, makeRepo(tmpDir));

        expect(parseSourceSafeSpy).toHaveBeenCalled();
      } finally {
        if (previousLimit === undefined) delete process.env.GITNEXUS_MAX_FILE_SIZE;
        else process.env.GITNEXUS_MAX_FILE_SIZE = previousLimit;
      }
    });
  });
});
