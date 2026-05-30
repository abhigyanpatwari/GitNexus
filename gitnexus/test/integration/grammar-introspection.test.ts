import { describe, it, expect } from 'vitest';
import Parser from 'tree-sitter';
import { SupportedLanguages } from '../../src/config/supported-languages.js';
import {
  getLanguageGrammar,
  isLanguageAvailable,
} from '../../src/core/tree-sitter/parser-loader.js';
import {
  GATED_LANGUAGES,
  loadGrammarModel,
  probeNodeType,
  validateNodeType,
  validateField,
  isNodeTypeError,
} from '../helpers/grammar-introspection.js';

describe('grammar-introspection helper', () => {
  describe('loadGrammarModel — membership set', () => {
    it('builds named, anonymous, supertype node types and per-node fields for Python', () => {
      const model = loadGrammarModel(SupportedLanguages.Python);
      expect(model).not.toBeNull();
      // named node, anonymous token, and a supertype name are all members
      expect(model!.nodeTypes.has('function_definition')).toBe(true);
      expect(model!.nodeTypes.has('{')).toBe(true);
      expect(model!.nodeTypes.has('expression')).toBe(true);
      // per-node fields
      const fields = model!.fieldsByNode.get('function_definition');
      expect(fields).toBeDefined();
      expect(fields!.has('name')).toBe(true);
      expect(fields!.has('body')).toBe(true);
      expect(fields!.has('parameters')).toBe(true);
      expect(model!.allFields.has('name')).toBe(true);
    });

    it('unions typescript ∪ tsx so JSX-only nodes are members', () => {
      const model = loadGrammarModel(SupportedLanguages.TypeScript);
      expect(model).not.toBeNull();
      expect(model!.nodeTypes.has('jsx_element')).toBe(true); // tsx-only
      expect(model!.nodeTypes.has('type_annotation')).toBe(true); // typescript
    });

    it('resolves PHP to the php_only variant (excludes embedded-HTML nodes)', () => {
      const model = loadGrammarModel(SupportedLanguages.PHP);
      expect(model).not.toBeNull();
      expect(model!.nodeTypes.has('function_definition')).toBe(true);
      // text_interpolation exists only in the full `php` (embedded-HTML) grammar
      expect(model!.nodeTypes.has('text_interpolation')).toBe(false);
    });

    it('excludes COBOL and never throws for any gated language', () => {
      expect(GATED_LANGUAGES).not.toContain(SupportedLanguages.Cobol);
      for (const lang of GATED_LANGUAGES) {
        // returns a model (installed) or null (optional grammar absent) — never throws
        expect(() => loadGrammarModel(lang)).not.toThrow();
      }
    });
  });

  describe('probeNodeType — live-grammar fallback', () => {
    it('classifies an absent node type as dead and a real one as valid (Rust)', () => {
      if (!isLanguageAvailable(SupportedLanguages.Rust)) return;
      expect(probeNodeType(SupportedLanguages.Rust, 'method_call_expression')).toBe('dead');
      expect(probeNodeType(SupportedLanguages.Rust, 'call_expression')).toBe('valid');
    });

    it('accepts an anonymous token via the "x" form (Python)', () => {
      if (!isLanguageAvailable(SupportedLanguages.Python)) return;
      expect(probeNodeType(SupportedLanguages.Python, '{')).toBe('valid');
    });

    it('accepts a supertype via membership without needing a probe (Python)', () => {
      const model = loadGrammarModel(SupportedLanguages.Python);
      expect(validateNodeType(SupportedLanguages.Python, model, 'expression')).toBe('valid');
    });

    it('returns unavailable (not throw) when a grammar cannot load', () => {
      // Drive through validateNodeType with a null model for an unavailable lang.
      // For installed langs this still must not throw.
      for (const lang of GATED_LANGUAGES) {
        expect(() => probeNodeType(lang, 'definitely_not_a_node_type_xyz')).not.toThrow();
      }
    });
  });

  describe('isNodeTypeError — classifier self-test', () => {
    it('matches the TSQueryErrorNodeType message and rejects valid queries', () => {
      if (!isLanguageAvailable(SupportedLanguages.Rust)) return;
      const grammar = getLanguageGrammar(SupportedLanguages.Rust) as ConstructorParameters<
        typeof Parser.Query
      >[0];
      let caught: unknown;
      try {
        // method_call_expression does not exist in tree-sitter-rust
        new Parser.Query(grammar, '(method_call_expression) @_');
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeDefined();
      // If a future tree-sitter bump changes the wording, this fails loudly
      // instead of silently passing every literal.
      expect(isNodeTypeError(caught)).toBe(true);
      // a valid node type compiles without throwing
      expect(() => new Parser.Query(grammar, '(call_expression) @_')).not.toThrow();
    });
  });

  describe('validateField', () => {
    it('passes a real node-scoped field and fails a non-existent one', () => {
      const model = loadGrammarModel(SupportedLanguages.Python);
      expect(validateField(model, 'name', 'function_definition')).toBe('valid');
      expect(validateField(model, 'nonexistent_field_xyz', 'function_definition')).toBe('dead');
    });
  });
});
