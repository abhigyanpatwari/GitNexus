import { describe, expect, it } from 'vitest';
import { SupportedLanguages } from 'gitnexus-shared';
import {
  EXT_LANG,
  isTypeDeclarationType,
  languageOf,
} from '../../../tools/scenario-map/facet/source-shape.js';

describe('source-shape language detection: R', () => {
  it.each(['parse(R, src)', 'parse(src, R)'])('names the grammar in %s', (call) => {
    expect(languageOf(call, 'test/unit/x.test.ts', [])).toBe(SupportedLanguages.R);
  });

  it('names R from a SupportedLanguages reference', () => {
    expect(languageOf('run(SupportedLanguages.R, src)', 'test/unit/x.test.ts', [])).toBe(
      SupportedLanguages.R,
    );
  });

  it('names R from a file-name literal, in either extension case', () => {
    expect(languageOf('write(f)', 'test/unit/x.test.ts', ['R/a.R'])).toBe(SupportedLanguages.R);
    expect(languageOf('write(f)', 'test/unit/x.test.ts', ['script.r'])).toBe(SupportedLanguages.R);
    expect(EXT_LANG.get('R')).toBe(SupportedLanguages.R);
  });

  it('names R from the test path, and leaves unrelated paths alone', () => {
    expect(languageOf('run()', 'gitnexus/test/unit/r-lexical-names.test.ts', [])).toBe(
      SupportedLanguages.R,
    );
    expect(languageOf('run()', 'gitnexus/test/unit/scope-resolution/r/x.test.ts', [])).toBe(
      SupportedLanguages.R,
    );
    expect(languageOf('run()', 'gitnexus/test/unit/receiver.test.ts', [])).toBeNull();
  });
});

describe('source-shape type-declaration node types', () => {
  it('admits declaration nodes of the supported grammars', () => {
    for (const type of [
      'class_declaration',
      'struct_item',
      'interface_declaration',
      'enum_declaration',
      'record_declaration',
      'object_declaration',
      'trait_item',
      'impl_item',
      'type_spec',
      'protocol_declaration',
    ]) {
      expect(isTypeDeclarationType(type), type).toBe(true);
    }
  });

  it('rejects body and list nodes anywhere in the name, and specifier as a suffix', () => {
    for (const type of [
      'class_body',
      'enum_body',
      'class_body_declaration',
      'field_declaration_list',
      'enumerator_list',
      'base_class_list',
      'class_specifier',
      'storage_class_specifier',
      'struct_specifier',
    ]) {
      expect(isTypeDeclarationType(type), type).toBe(false);
    }
  });

  it('does not treat specifier in the middle of a name as a suffix', () => {
    expect(isTypeDeclarationType('class_specifier_clause')).toBe(true);
  });
});
