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
  probeField,
  validateNodeType,
  validateField,
  isNodeTypeError,
  isFieldError,
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

    it('classifies a bogus node type as dead for installed grammars (never just not-throw)', () => {
      for (const lang of GATED_LANGUAGES) {
        const verdict = probeNodeType(lang, 'definitely_not_a_node_type_xyz');
        // installed → an absent node type is 'dead'; uninstalled optional grammar → 'unavailable'.
        if (isLanguageAvailable(lang)) {
          expect(verdict, `${lang} should classify a bogus node type as dead`).toBe('dead');
        } else {
          expect(verdict).toBe('unavailable');
        }
      }
    });

    it('distinguishes the null-model paths: validateField unavailable vs validateNodeType still probes', () => {
      // validateField short-circuits to unavailable with no model (no grammar set).
      expect(validateField(null, 'anything', 'some_node')).toBe('unavailable');
      // validateNodeType, by contrast, still probes the LIVE grammar when the model
      // is null, so for an installed language a bogus node type is 'dead'.
      if (isLanguageAvailable(SupportedLanguages.Python)) {
        expect(validateNodeType(SupportedLanguages.Python, null, 'definitely_not_xyz')).toBe(
          'dead',
        );
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

    it('rescues a JSON-under-reported / supertype-permissive field via the probe (not a false positive)', () => {
      // C# `parameter` has no `pattern` field (TSQueryErrorStructure), but
      // `binary_expression` accepts `pattern` through its supertype-typed slots,
      // so the probe compiles and validateField must NOT flag it dead. This pins
      // the conservative-toward-valid direction: a membership miss falls through
      // to the probe, never straight to dead.
      if (!isLanguageAvailable(SupportedLanguages.CSharp)) return;
      const model = loadGrammarModel(SupportedLanguages.CSharp);
      expect(validateField(model, 'pattern', 'parameter')).toBe('dead'); // structurally impossible
      expect(validateField(model, 'pattern', 'binary_expression')).toBe('valid'); // probe-rescued
    });
  });

  describe('probeField — conservative node-scoped field oracle', () => {
    it('classifies a structurally-impossible field as dead (C# parameter/pattern)', () => {
      if (!isLanguageAvailable(SupportedLanguages.CSharp)) return;
      // (parameter pattern: (_)) throws TSQueryErrorStructure
      expect(probeField(SupportedLanguages.CSharp, 'parameter', 'pattern')).toBe('dead');
      // an unknown field name throws TSQueryErrorField
      expect(probeField(SupportedLanguages.CSharp, 'parameter', 'total_garbage_field')).toBe(
        'dead',
      );
      // a real field compiles
      expect(probeField(SupportedLanguages.CSharp, 'parameter', 'type')).toBe('valid');
    });

    it('returns unavailable (not dead) when the node type is absent in the grammar', () => {
      if (!isLanguageAvailable(SupportedLanguages.Java)) return;
      // `parameter` is not a Java node (Java uses `formal_parameter`) → NodeType error
      // → unavailable, so multi-language ANY-semantics can defer to the right grammar.
      expect(probeField(SupportedLanguages.Java, 'parameter', 'name')).toBe('unavailable');
    });

    it('is conservative-toward-valid for supertype-typed fields (never false-positive)', () => {
      if (!isLanguageAvailable(SupportedLanguages.CSharp)) return;
      // `binary_expression` has no `pattern` field, but its supertype-typed slots
      // make the query compile → valid. The probe errs toward valid by design.
      expect(probeField(SupportedLanguages.CSharp, 'binary_expression', 'pattern')).toBe('valid');
    });

    it('never throws for any gated language', () => {
      for (const lang of GATED_LANGUAGES) {
        expect(() => probeField(lang, 'some_node', 'some_field')).not.toThrow();
      }
    });
  });

  describe('isFieldError — classifier self-test', () => {
    it('matches TSQueryErrorStructure and TSQueryErrorField but not NodeType', () => {
      if (!isLanguageAvailable(SupportedLanguages.CSharp)) return;
      const grammar = getLanguageGrammar(SupportedLanguages.CSharp) as ConstructorParameters<
        typeof Parser.Query
      >[0];
      const grab = (q: string): unknown => {
        try {
          new Parser.Query(grammar, q);
          return undefined;
        } catch (e) {
          return e;
        }
      };
      const structureErr = grab('(parameter pattern: (_)) @_'); // TSQueryErrorStructure
      const fieldErr = grab('(parameter total_garbage_field: (_)) @_'); // TSQueryErrorField
      const nodeTypeErr = grab('(nonexistent_node_xyz) @_'); // TSQueryErrorNodeType
      expect(structureErr).toBeDefined();
      expect(fieldErr).toBeDefined();
      expect(nodeTypeErr).toBeDefined();
      expect(isFieldError(structureErr)).toBe(true);
      expect(isFieldError(fieldErr)).toBe(true);
      // a node-type error is NOT a field error (it routes to `unavailable`, not `dead`)
      expect(isFieldError(nodeTypeErr)).toBe(false);
      expect(isNodeTypeError(nodeTypeErr)).toBe(true);
    });
  });
});
