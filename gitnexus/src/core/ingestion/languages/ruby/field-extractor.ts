import type { FieldExtractor } from '../../field-extractor.js';
import { createFieldExtractor } from '../../field-extractors/generic.js';
import { rubyConfig } from '../../field-extractors/configs/ruby.js';

const declarationExtractor = createFieldExtractor(rubyConfig);

export const rubyFieldExtractor: FieldExtractor = {
  language: declarationExtractor.language,
  isTypeDeclaration: (node) => declarationExtractor.isTypeDeclaration(node),
  extract(node, context) {
    const extracted = declarationExtractor.extract(node, context);
    if (extracted === null) return null;

    // Accessors describe one property: any setter makes that property writable.
    const writable = new Set<string>();
    for (const field of extracted.fields) {
      if (!field.isReadonly) writable.add(field.name);
    }
    for (const field of extracted.fields) {
      if (writable.has(field.name)) field.isReadonly = false;
    }
    return extracted;
  },
};
