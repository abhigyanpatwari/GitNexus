import { SupportedLanguages } from 'gitnexus-shared';
import type { ClassExtractionConfig, ClassLikeNodeLabel } from '../../class-types.js';

export const scalaClassConfig: ClassExtractionConfig = {
  language: SupportedLanguages.Scala,
  typeDeclarationNodes: [
    'class_definition',
    'object_definition',
    'trait_definition',
    'enum_definition',
  ],
  fileScopeNodeTypes: ['compilation_unit'],
  ancestorScopeNodeTypes: ['class_definition', 'object_definition', 'trait_definition'],

  extractName(node) {
    return node.childForFieldName('name')?.text;
  },

  extractType(node): ClassLikeNodeLabel | undefined {
    switch (node.type) {
      case 'class_definition':
        return 'Class';
      case 'trait_definition':
        return 'Interface';
      case 'object_definition':
        return 'Class';
      case 'enum_definition':
        return 'Enum';
      default:
        return undefined;
    }
  },
};
