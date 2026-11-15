import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  getRelationships,
  getNodesByLabel,
  runPipelineFromRepo,
  writeFixtureRepo,
} from './resolvers/helpers.js';
import { isLanguageAvailable } from '../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';

describe.skipIf(!isLanguageAvailable(SupportedLanguages.Swift))(
  'Swift hoisted return ownership',
  () => {
    it.each([
      [
        'same-arity overload',
        `class User { func save() {} }
class Admin { func save() {} }
class Service {
    func getUser(_ id: Int) -> User { return User() }
    func getUser(_ name: String) -> Admin { return Admin() }
}
func probe(svc: Service) { svc.getUser(1).save() }
`,
        'Admin',
        false,
      ],
      [
        'same-owner overload',
        `class User { func save() {} }
class Admin { func save() {} }
class Service {
    func getUser() -> User { return User() }
    func getUser(_ id: Int) -> Admin { return Admin() }
}
func probe(svc: Service) { svc.getUser().save() }
`,
        'Admin',
        false,
      ],
      [
        'nearer override shadows late base',
        `class User { func save() {} }
class Admin: User { override func save() {} }
class Child: Base {
    override func getUser() -> Admin { return Admin() }
}
class Base {
    func getUser() -> User { return User() }
}
func probe(svc: Child) { svc.getUser().save() }
`,
        'User',
        true,
      ],
      [
        'single declaration remains positive',
        `class User { func save() {} }
class Service { func getUser() -> User { return User() } }
func probe(svc: Service) { svc.getUser().save() }
`,
        'Admin',
        false,
      ],
    ] as const)(
      '%s',
      async (label, source, wrongOwner, inherited) => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-swift-return-owner-'));
        try {
          const receiver = inherited ? 'Child' : 'Service';
          const argument = label === 'same-arity overload' ? '1' : '';
          writeFixtureRepo(root, {
            'Models.swift':
              source +
              `
func probeBound(svc: ${receiver}) {
    let user = svc.getUser(${argument})
    user.save()
}
`,
          });
          const result = await runPipelineFromRepo(root, () => {}, {});
          expect(getNodesByLabel(result, 'Class')).toContain('User');
          const edges = getRelationships(result, 'CALLS').filter(
            (e) => (e.source === 'probe' || e.source === 'probeBound') && e.target === 'save',
          );
          expect(edges.filter((e) => e.rel.targetId.includes(`${wrongOwner}.save`))).toEqual([]);
          if (label === 'same-arity overload') {
            expect(edges).toEqual([]);
          }
          if (label === 'same-owner overload') {
            const bound = edges.filter((e) => e.source === 'probeBound');
            expect(bound).toHaveLength(1);
            expect(bound[0]!.rel.targetId).toContain('User.save');
          }
          if (inherited)
            expect(
              getRelationships(result, 'EXTENDS').some(
                (e) => e.source === 'Child' && e.target === 'Base',
              ),
            ).toBe(true);
          if (inherited) {
            for (const caller of ['probe', 'probeBound']) {
              const targets = edges.filter((e) => e.source === caller).map((e) => e.rel.targetId);
              expect(targets).toHaveLength(1);
              expect(targets[0]).toContain('Admin.save');
            }
          }
          if (label === 'single declaration remains positive') expect(edges).toHaveLength(2);
        } finally {
          fs.rmSync(root, { recursive: true, force: true });
        }
      },
      120000,
    );
  },
);
