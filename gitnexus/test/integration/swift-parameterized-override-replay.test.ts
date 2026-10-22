import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { getRelationships, runPipelineFromRepo, writeFixtureRepo } from './resolvers/helpers.js';
import { isLanguageAvailable } from '../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';

const swiftAvailable = isLanguageAvailable(SupportedLanguages.Swift);

it.skipIf(!swiftAvailable)(
  'retains the bound return type of a parameterized Swift override',
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-swift-override-replay-'));
    try {
      writeFixtureRepo(root, {
        'Main.swift': `class User { func save() {} }
class Admin: User { override func save() {} }
class Base { func find(_ id: Int) -> User { User() } }
class Child: Base { override func find(_ id: Int) -> Admin { Admin() } }
func probeBound(svc: Child) { let u = svc.find(1); u.save() }
`,
      });
      const result = await runPipelineFromRepo(root, () => {}, {});
      const calls = getRelationships(result, 'CALLS').filter(
        (edge) => edge.source === 'probeBound' && edge.target === 'save',
      );
      expect(calls).toHaveLength(1);
      expect(calls[0]?.rel.targetId).toBe('Function:Main.swift:Admin.save#0');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);

it.skipIf(!swiftAvailable)(
  'declines inherited same-arity methods with different parameter types',
  async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-swift-overload-replay-'));
    try {
      writeFixtureRepo(root, {
        'Main.swift': `class User { func save() {} }
class Admin { func save() {} }
class Base { func find(_ id: Int) -> User { User() } }
class Child: Base { func find(_ name: String) -> Admin { Admin() } }
func probeBound(svc: Child) { let u = svc.find(1); u.save() }
`,
      });
      const result = await runPipelineFromRepo(root, () => {}, {});
      const calls = getRelationships(result, 'CALLS').filter(
        (edge) => edge.source === 'probeBound' && edge.target === 'save',
      );
      expect(calls).toEqual([]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
