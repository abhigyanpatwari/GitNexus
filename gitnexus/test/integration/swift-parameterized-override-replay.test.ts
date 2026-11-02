import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { getRelationships, runPipelineFromRepo, writeFixtureRepo } from './resolvers/helpers.js';
import { isLanguageAvailable } from '../../src/core/tree-sitter/parser-loader.js';
import { SupportedLanguages } from '../../src/config/supported-languages.js';

describe.skipIf(!isLanguageAvailable(SupportedLanguages.Swift))(
  'Swift assigned override returns',
  () => {
    it.each([
      { label: 'fixed parameters', parameter: '_ ids: Int', args: '1' },
      { label: 'variadic parameters', parameter: '_ ids: Int...', args: '1, 2' },
    ])('retains the exact bound return for $label', async ({ parameter, args }) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-swift-override-replay-'));
      try {
        writeFixtureRepo(root, {
          'Main.swift': `class User { func save() {} }
class Admin: User { override func save() {} }
class Base { func find(${parameter}) -> User { User() } }
class Child: Base { override func find(${parameter}) -> Admin { Admin() } }
func probeBound(svc: Child) { let u = svc.find(${args}); u.save() }
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
    });

    it.each([
      {
        label: 'different fixed parameter types',
        base: '_ value: Int',
        child: '_ value: String',
        args: '1',
      },
      {
        label: 'different variadic parameter types',
        base: '_ values: Int...',
        child: '_ values: String...',
        args: '1, 2',
      },
      {
        label: 'different metatype parameter types',
        base: '_ kind: User.Type, _ values: Int...',
        child: '_ kind: Admin.Type, _ values: Int...',
        args: 'User.self, 1, 2',
      },
    ])('preserves return-owner precision for $label', async ({ base, child, args }) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gn-swift-overload-replay-'));
      try {
        writeFixtureRepo(root, {
          'Main.swift': `class User { func save() {} }
class Admin { func save() {} }
class Base { func find(${base}) -> User { User() } }
class Child: Base { func find(${child}) -> Admin { Admin() } }
func probeBound(svc: Child) { let u = svc.find(${args}); u.save() }
func probeControl(user: User) { user.save() }
`,
        });
        const result = await runPipelineFromRepo(root, () => {}, {});
        const calls = getRelationships(result, 'CALLS').filter(
          (edge) => edge.source === 'probeBound' && edge.target === 'save',
        );
        // Call argument types are not captured yet. Check owner precision
        // without requiring the correct inherited result to stay unresolved.
        for (const call of calls) {
          expect(call.rel.targetId).toBe('Function:Main.swift:User.save#0');
        }
        // This supported call checks fixture-local resolution, not completeness
        // of the primary call or coverage of every selective primary-path loss.
        const controlCalls = getRelationships(result, 'CALLS')
          .filter((edge) => edge.source === 'probeControl' && edge.target === 'save')
          .map((edge) => edge.rel.targetId)
          .sort();
        expect(controlCalls).toEqual(['Function:Main.swift:User.save#0']);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  },
);
