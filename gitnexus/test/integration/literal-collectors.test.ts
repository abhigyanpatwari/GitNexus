import { describe, it, expect } from 'vitest';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
import {
  collectAllLiterals,
  __test,
  type CollectedNodeType,
} from '../helpers/literal-collectors.js';

const hasNodeType = (
  list: CollectedNodeType[],
  literal: string,
  lang?: SupportedLanguages,
): boolean =>
  list.some((n) => n.literal === literal && (lang === undefined || n.languages.includes(lang)));

describe('literal-collectors', () => {
  describe('Mode 1 — config reflection', () => {
    it('splits c-cpp configs by language', async () => {
      const { nodeTypes } = await collectAllLiterals();
      const config = nodeTypes.filter((n) => n.source === 'config');
      expect(hasNodeType(config, 'struct_specifier', SupportedLanguages.C)).toBe(true);
      expect(hasNodeType(config, 'class_specifier', SupportedLanguages.CPlusPlus)).toBe(true);
    });
  });

  describe('Mode 2 — AST scan over the extraction surface', () => {
    const { nodeTypes, fields } = __test.collectInCodeLiterals();

    it('collects literals that live OUTSIDE configs/ (the surface fix)', () => {
      // direct `.type ===` in a single-language type-extractor (a valid, kept literal)
      expect(hasNodeType(nodeTypes, 'call_expression', SupportedLanguages.Rust)).toBe(true);
      // a literal inside a per-language captures.ts (valid, kept)
      expect(hasNodeType(nodeTypes, 'reference_declarator', SupportedLanguages.CPlusPlus)).toBe(
        true,
      );
    });

    it('collects members of a Set consumed against node.type (RUBY_METHOD_NODE_TYPES)', () => {
      const setMembers = nodeTypes.filter((n) => n.source === 'set-member');
      expect(hasNodeType(setMembers, 'singleton_method', SupportedLanguages.Ruby)).toBe(true);
    });

    it('collects export-detection.ts language-named set members tagged by const prefix', () => {
      // CSHARP_DECL_TYPES is consumed via `.has(node.type)`; a valid, kept member
      expect(hasNodeType(nodeTypes, 'record_declaration', SupportedLanguages.CSharp)).toBe(true);
    });

    it('B1 guard: semantic type-name sets are NOT collected as node types', () => {
      // PRIMITIVE_TYPES / NULLABLE_WRAPPER_TYPES are consumed via .has(text) /
      // .has(name), never .has(node.type), so their members must never appear.
      expect(hasNodeType(nodeTypes, 'i32')).toBe(false);
      expect(hasNodeType(nodeTypes, 'usize')).toBe(false);
      expect(hasNodeType(nodeTypes, 'Optional')).toBe(false);
    });

    it('collects field literals and never collects capture-tag strings as node types', () => {
      expect(fields.length).toBeGreaterThan(0);
      // capture tags start with '@' and are compared by name/role, never as node types
      expect(nodeTypes.some((n) => n.literal.startsWith('@'))).toBe(false);
    });

    it('captures the receiver node type from a positive type-guard; leaves ungated lookups unscoped', () => {
      // if (node.type === 'is_pattern_expression') { ... node.childForFieldName('pattern') }
      const scoped = fields.find(
        (f) =>
          f.field === 'pattern' &&
          f.receiverNodeType === 'is_pattern_expression' &&
          f.file.endsWith('type-extractors/csharp.ts'),
      );
      expect(scoped).toBeDefined();
      // a childForFieldName NOT inside a single positive type-guard stays unscoped
      // (receiverNodeType undefined) → the gate uses the sound global field check.
      const unscoped = fields.find((f) => f.receiverNodeType === undefined);
      expect(unscoped).toBeDefined();
    });

    it('does not scan the COBOL or resolution layer', () => {
      expect(nodeTypes.some((n) => n.file.includes('cobol'))).toBe(false);
      // resolution-layer files (where .type is a resolved-symbol kind) are excluded
      expect(nodeTypes.some((n) => n.file.endsWith('call-processor.ts'))).toBe(false);
      expect(nodeTypes.some((n) => n.file.endsWith('type-env.ts'))).toBe(false);
    });
  });

  describe('fileLanguages — `*-harvest.ts` map to their grammar (U10)', () => {
    const fl = __test.fileLanguages;
    it('maps each <lang>-harvest.ts to the same grammar(s) as its <lang>.ts visitor', () => {
      expect(fl('cfg/visitors/go-harvest.ts')).toEqual([SupportedLanguages.Go]);
      expect(fl('cfg/visitors/csharp-harvest.ts')).toEqual([SupportedLanguages.CSharp]);
      expect(fl('cfg/visitors/typescript-harvest.ts')).toEqual([SupportedLanguages.TypeScript]);
      expect(fl('cfg/visitors/c-cpp-harvest.ts')).toEqual([
        SupportedLanguages.C,
        SupportedLanguages.CPlusPlus,
      ]);
      // a harvester pins exactly its visitor's grammar set, not the weak ALL_LANGS
      expect(fl('cfg/visitors/go-harvest.ts')).toEqual(fl('cfg/visitors/go.ts'));
    });
    it('leaves the language-agnostic harvesters valid-if-any (ALL_LANGS)', () => {
      const all = fl('cfg/visitors/call-site-harvest.ts');
      const scopeTree = fl('cfg/visitors/scope-tree-harvest.ts');
      // both name no grammar → fall through to the full gated set, which is far
      // larger than any single-/dual-language harvester mapping
      expect(all.length).toBeGreaterThan(2);
      expect(scopeTree).toEqual(all);
    });
  });

  describe('Mode 4 — registry resolution layer (TypeChecker-gated)', () => {
    it('scans the resolution layer and tags literals by language dir', () => {
      const { nodeTypes } = __test.collectResolutionLayerLiterals();
      // The TS Program must have built (else coverage is silently lost).
      expect(nodeTypes.length).toBeGreaterThan(0);
      // a real cpp resolution-layer node type (arity-metadata.ts) tagged C++
      expect(hasNodeType(nodeTypes, 'parameter_declaration', SupportedLanguages.CPlusPlus)).toBe(
        true,
      );
      // discriminator: resolution-layer literals are grammar nodes (snake_case /
      // anonymous), never resolved-symbol PascalCase kinds like 'Class'/'Struct'.
      expect(nodeTypes.some((n) => /^[A-Z]/.test(n.literal))).toBe(false);
    });

    it('scans shared resolution files (type-env.ts) tagged with the full language set', () => {
      const { nodeTypes } = __test.collectResolutionLayerLiterals();
      const typeEnv = nodeTypes.filter((n) => n.file.endsWith('type-env.ts'));
      expect(typeEnv.length).toBeGreaterThan(0);
      // shared (non-languages/<lang>/) file → tagged with the full gated set
      // (valid-if-any), not a single language.
      expect(typeEnv.every((n) => n.languages.length > 1)).toBe(true);
    });
  });

  describe('Mode 3 — registry scope-query probes', () => {
    it('probes available languages registry scope queries', async () => {
      const { queryProbes } = await collectAllLiterals();
      expect(queryProbes.length).toBeGreaterThan(0);
      // every probe carries a language + getter name
      for (const p of queryProbes) {
        expect(p.getter).toBeTruthy();
      }
    });
  });
});
