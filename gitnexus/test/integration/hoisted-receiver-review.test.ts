import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runPipelineFromRepo } from '../../src/core/ingestion/pipeline.js';
import { TransitionalScopeTree } from '../../src/storage/scope-index-store.js';
import {
  isLanguageAvailable,
  loadParser,
  loadLanguage,
} from '../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
let dartAvailable = isLanguageAvailable(SupportedLanguages.Dart);
if (dartAvailable) {
  try {
    await loadParser();
    await loadLanguage(SupportedLanguages.Dart);
  } catch {
    dartAvailable = false;
  }
}
const swiftAvailable = isLanguageAvailable(SupportedLanguages.Swift);
const swift = `class User { func save() {} }
class Admin { func save() {} }
class Service { func getUser() -> User { return User() } }
func probe(svc: Service) { svc.getUser().save() }
`;
const dart = `class User { void save() {} }
class Admin { void save() {} }
class Service { User getUser() => User(); }
void probe(Service svc) { svc.getUser().save(); }
`;
describe('hoisted receiver review regressions', () => {
  for (const [label, file, source, available] of [
    ['Swift', 'Models.swift', swift, swiftAvailable],
    ['Dart', 'models.dart', dart, dartAvailable],
  ] as const) {
    it.skipIf(!available)(
      `${label} preserves exact edges after the disk seal`,
      async () => {
        const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-hoisted-disk-'));
        const store = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-hoisted-store-'));
        const previous = process.env.GITNEXUS_DISK_SCOPE_INDEX;
        const seal = vi.spyOn(TransitionalScopeTree.prototype, 'seal');
        try {
          await fs.writeFile(path.join(root, file), source);
          const outputs: string[][] = [];
          for (const disk of [false, true]) {
            process.env.GITNEXUS_DISK_SCOPE_INDEX = disk ? '1' : '0';
            seal.mockClear();
            const result = await runPipelineFromRepo(root, () => {}, {
              parsedFileStorePath: path.join(store, disk ? 'disk' : 'resident'),
            });
            expect(seal).toHaveBeenCalledTimes(disk ? 1 : 0);
            const calls = [...result.graph.iterRelationships()]
              .filter(
                (e) =>
                  e.type === 'CALLS' &&
                  result.graph.getNode(e.sourceId)?.properties.name === 'probe' &&
                  result.graph.getNode(e.targetId)?.properties.name === 'save',
              )
              .map((e) => e.targetId)
              .sort();
            expect(calls).toHaveLength(1);
            expect(calls[0]).toContain('User.save');
            outputs.push(calls);
          }
          expect(outputs[1]).toEqual(outputs[0]);
        } finally {
          seal.mockRestore();
          if (previous === undefined) delete process.env.GITNEXUS_DISK_SCOPE_INDEX;
          else process.env.GITNEXUS_DISK_SCOPE_INDEX = previous;
          await fs.rm(root, { recursive: true, force: true });
          await fs.rm(store, { recursive: true, force: true });
        }
      },
      120000,
    );
  }
  it.skipIf(!swiftAvailable)(
    'does not borrow an inherited overload return',
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-swift-inherited-overload-'));
      try {
        await fs.writeFile(
          path.join(root, 'Models.swift'),
          `class User { func save() {} }
class Admin { func save() {} }
class Base { func getUser() -> User { return User() } }
class Child: Base { func getUser(_ id: Int) -> Admin { return Admin() } }
func probe(svc: Child) { svc.getUser().save() }
func probeBound(svc: Child) { let user = svc.getUser(); user.save() }
`,
        );
        const result = await runPipelineFromRepo(root, () => {}, {});
        // Decline this inherited overload until the intermediate call carries
        // enough argument evidence to select Base.getUser() and User.save.
        const saveCalls = [...result.graph.iterRelationships()].filter(
          (e) =>
            e.type === 'CALLS' &&
            ['probe', 'probeBound'].includes(
              result.graph.getNode(e.sourceId)?.properties.name ?? '',
            ) &&
            e.targetId.includes('.save'),
        );
        expect(saveCalls).toEqual([]);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
    120000,
  );
  it.skipIf(!dartAvailable)(
    'does not invoke a method tear-off while reading its field',
    async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), 'gn-dart-tearoff-'));
      try {
        await fs.writeFile(
          path.join(root, 'models.dart'),
          `class Admin { void save() {} }
class User { Admin call() => Admin(); void save() {} }
class Service { User getUser() => User(); }
void probe(Service svc) { svc.getUser.call().save(); }
`,
        );
        const result = await runPipelineFromRepo(root, () => {}, {});
        const saveCalls = [...result.graph.iterRelationships()].filter(
          (e) =>
            e.type === 'CALLS' &&
            result.graph.getNode(e.sourceId)?.properties.name === 'probe' &&
            e.targetId.includes('.save'),
        );
        expect(saveCalls).toEqual([]);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
    120000,
  );
});
