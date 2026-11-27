/**
 * A Swift `import X` persists an IMPORTS edge only to the files of X that
 * declare something the importer reaches. Adding, removing or moving such a
 * declaration changes the importer's edges without touching the importer, so
 * an incremental run must still end equal to a full rebuild. Whether an
 * importer reaches a file depends on the importer and that file, and on one
 * more file only through a top-level `typealias` declared in a file the
 * importer keeps. A declaration in any other file must not change it: a second
 * type named like an extended type is itself kept when the importer spells
 * that name, but the extension file is kept or dropped exactly as before.
 * Retargeting the alias, or moving the type it names, must still end equal to
 * a full rebuild.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { closeLbug, executeQuery, initLbug } from '../../src/core/lbug/lbug-adapter.js';
import { runFullAnalysis } from '../../src/core/run-analyze.js';
import { getStoragePaths } from '../../src/storage/repo-manager.js';
import { isLanguageAvailable } from '../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
import { commitAll, initGitRepo } from '../helpers/temp-git-repo.js';
import { createTempDir } from '../helpers/test-db.js';

const VIEW = 'Sources/App/View.swift';
const MODEL = 'Sources/DTO/Model.swift';
const OTHER = 'Sources/DTO/Other.swift';
const HELPER = 'Sources/DTO/Helper.swift';
const UTIL = 'Sources/DTO/Util.swift';
const EXTRAS = 'Sources/DTO/Extras.swift';
const CHAIN = 'Sources/App/Chain.swift';
const SECOND_UTIL = 'Sources/DTO/More/Util.swift';
const TARGET = 'Sources/DTO/Target.swift';
const SECOND = 'Sources/DTO/Second.swift';
const MOVED = 'Sources/DTO/Moved/Second.swift';
const ALIAS = 'Sources/DTO/Alias.swift';
const ALIAS_USER = 'Sources/App/AliasUser.swift';

const MANIFEST = `// swift-tools-version:5.7
import PackageDescription

let package = Package(
    name: "Shop",
    targets: [
        .target(name: "DTO"),
        .target(name: "App", dependencies: ["DTO"]),
    ]
)
`;
const VIEW_SOURCE = `import DTO

func show(_ model: Model) {
    model.run()
    Helper().go()
}
`;
const OTHER_SOURCE = 'public final class Other {\n    public init() {}\n}\n';
const HELPER_DECL =
  'public final class Helper {\n    public init() {}\n    public func go() {}\n}\n';

it.skipIf(!isLanguageAvailable(SupportedLanguages.Swift))(
  'keeps incremental Swift module imports equal to a full rebuild',
  async () => {
    const temp = await createTempDir();
    try {
      const root = await fs.realpath(temp.dbPath);
      vi.stubEnv('GITNEXUS_HOME', path.join(root, 'home'));
      vi.stubEnv('GITNEXUS_STORAGE_PATH', undefined);
      vi.stubEnv('GITNEXUS_STORAGE_ROOT', undefined);
      vi.stubEnv('GITNEXUS_SHARED_STORE', 'off');
      vi.stubEnv('GITNEXUS_LBUG_EXTENSION_INSTALL', 'load-only');
      const repo = path.join(root, 'incremental');
      const coldRepo = path.join(root, 'cold');
      const repos = [repo, coldRepo];
      const write = async (file: string, source: string): Promise<void> => {
        for (const target of repos) {
          await fs.mkdir(path.dirname(path.join(target, file)), { recursive: true });
          await fs.writeFile(path.join(target, file), source);
        }
      };
      const remove = async (file: string): Promise<void> => {
        for (const target of repos) await fs.rm(path.join(target, file));
      };
      const commit = (message: string): void =>
        repos.forEach((target) => commitAll(target, message));
      for (const [file, source] of [
        ['.gitignore', '.gitnexus/\n'],
        ['Package.swift', MANIFEST],
        [MODEL, 'public final class Model {\n    public init() {}\n    public func run() {}\n}\n'],
        [OTHER, OTHER_SOURCE],
        [VIEW, VIEW_SOURCE],
        [UTIL, 'public struct Util {\n    public init() {}\n}\n'],
        [EXTRAS, 'public extension Util {\n    func extra() {}\n}\n'],
        [CHAIN, 'import DTO\n\nfunc chain() {\n    let m = Util()\n    m.extra()\n}\n'],
      ] as const)
        await write(file, source);
      for (const target of repos) {
        initGitRepo(target);
        execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: target });
      }
      commit('baseline Swift modules');

      const options = { skipAgentsMd: true, skipSkills: true, skipFts: true };
      const callbacks = { onProgress: () => {} };
      const read = async (target: string) => {
        await initLbug(getStoragePaths(target).lbugPath, { skipFts: true });
        try {
          const rows = async (type: string) =>
            executeQuery(
              `MATCH (s)-[r:CodeRelation]->(t) WHERE r.type = '${type}' ` +
                'RETURN s.id AS source, t.id AS target, r.reason AS reason ' +
                'ORDER BY source, target, reason',
            );
          return {
            imports: await rows('IMPORTS'),
            calls: await rows('CALLS'),
            accesses: await rows('ACCESSES'),
          };
        } finally {
          await closeLbug();
        }
      };
      const importsOf = (state: Awaited<ReturnType<typeof read>>, file: string): string[] =>
        state.imports
          .filter(
            (row) => row.source === `File:${file}` && String(row.reason) === 'swift-scope: import',
          )
          .map((row) => String(row.target))
          .sort();
      const viewImports = (state: Awaited<ReturnType<typeof read>>) => importsOf(state, VIEW);
      /** Analyze the incremental repository, rebuild the cold one from scratch,
       * and require the same persisted rows in both. */
      const analyzeBoth = async (
        expectedViewImports: readonly string[],
        expectedChainImports: readonly string[] = [EXTRAS, UTIL],
        expectedAliasUserImports: readonly string[] = [],
      ) => {
        const result = await runFullAnalysis(repo, options, callbacks);
        await runFullAnalysis(
          coldRepo,
          { ...options, force: true, useParseCache: false },
          callbacks,
        );
        const cold = await read(coldRepo);
        expect(viewImports(cold)).toEqual(expectedViewImports.map((file) => `File:${file}`));
        expect(importsOf(cold, CHAIN)).toEqual(expectedChainImports.map((file) => `File:${file}`));
        expect(importsOf(cold, ALIAS_USER)).toEqual(
          expectedAliasUserImports.map((file) => `File:${file}`),
        );
        expect(await read(repo)).toEqual(cold);
        return result.incrementalStats;
      };

      await analyzeBoth([MODEL]);

      // A module file gains a declaration the unchanged importer already spells.
      await write(OTHER, OTHER_SOURCE + HELPER_DECL);
      commit('declare Helper in Other.swift');
      expect(await analyzeBoth([MODEL, OTHER])).toMatchObject({ writeMode: 'incremental' });

      // ...and loses it again.
      await write(OTHER, OTHER_SOURCE);
      commit('remove Helper from Other.swift');
      expect(await analyzeBoth([MODEL])).toMatchObject({ writeMode: 'incremental' });

      // A new module file declares it.
      await write(HELPER, HELPER_DECL);
      commit('add Helper.swift');
      expect(await analyzeBoth([HELPER, MODEL])).toMatchObject({ writeMode: 'incremental' });

      // ...and is deleted.
      await remove(HELPER);
      commit('delete Helper.swift');
      expect(await analyzeBoth([MODEL])).toMatchObject({ writeMode: 'incremental' });

      // The importer starts spelling another name of the module.
      await write(VIEW, VIEW_SOURCE.replace('Helper().go()', '_ = Other()'));
      commit('use Other in View.swift');
      expect(await analyzeBoth([MODEL, OTHER])).toMatchObject({ writeMode: 'incremental' });

      // A second type named like the extended one appears in another file of
      // the module, and goes again. Chain.swift spells `Util`, so the new file
      // is kept by name; the extension file stays kept either way.
      await write(SECOND_UTIL, 'struct Util {}\n');
      commit('add a second Util');
      expect(await analyzeBoth([MODEL, OTHER], [EXTRAS, SECOND_UTIL, UTIL])).toMatchObject({
        writeMode: 'incremental',
      });
      await remove(SECOND_UTIL);
      commit('remove the second Util');
      expect(await analyzeBoth([MODEL, OTHER])).toMatchObject({ writeMode: 'incremental' });

      // An importer that spells only an alias reaches the alias's file and,
      // one hop on, the file declaring the aliased type.
      await write(TARGET, 'public struct Target {\n    public init() {}\n}\n');
      await write(SECOND, 'public struct Second {\n    public init() {}\n}\n');
      await write(ALIAS, 'public typealias Bar = Target\n');
      await write(ALIAS_USER, 'import DTO\n\nfunc useBar() {\n    _ = Bar()\n}\n');
      commit('add an alias and its user');
      expect(await analyzeBoth([MODEL, OTHER], [EXTRAS, UTIL], [ALIAS, TARGET])).toMatchObject({
        writeMode: 'incremental',
      });

      // Only the alias file changes: the unchanged user follows the new target.
      await write(ALIAS, 'public typealias Bar = Second\n');
      commit('retarget the alias');
      expect(await analyzeBoth([MODEL, OTHER], [EXTRAS, UTIL], [ALIAS, SECOND])).toMatchObject({
        writeMode: 'incremental',
      });

      // The aliased type moves to another file.
      await remove(SECOND);
      await write(MOVED, 'public struct Second {\n    public init() {}\n}\n');
      commit('move the aliased type');
      expect(await analyzeBoth([MODEL, OTHER], [EXTRAS, UTIL], [ALIAS, MOVED])).toMatchObject({
        writeMode: 'incremental',
      });
    } finally {
      await closeLbug();
      vi.unstubAllEnvs();
      await temp.cleanup();
    }
  },
  600_000,
);
