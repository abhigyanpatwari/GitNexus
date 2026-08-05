// gitnexus/src/core/ingestion/class-extractors/configs/go.ts

import { SupportedLanguages } from 'gitnexus-shared';
import type { ClassExtractionConfig } from '../../class-types.js';

/**
 * The node a Go type declaration is identified by.
 *
 * `type_spec` is the granular form and the one the capture layer now anchors on
 * (#2837) — one per declared type, so a grouped `type ( A struct{…}; B struct{…} )`
 * yields one per member instead of one for the block. `type_declaration` stays
 * accepted because other callers still reach this extractor with the wrapper node
 * (`findEnclosingClassInfo`'s walk, and any language-neutral path that hands over
 * a declaration rather than a spec).
 *
 * Accepting only `type_declaration` meant a `type_spec` failed `isTypeDeclaration`,
 * `extract()` returned null, and every Go struct/interface silently lost its
 * package-qualified name (measured: `repository.OrderRepo` -> `undefined`).
 */
const GO_TYPE_DECLARATION_NODES = ['type_declaration', 'type_spec'];

/** The `type_spec` this node denotes: itself when it already is one, else the
 *  first one under a `type_declaration` wrapper. */
function goTypeSpecOf(node: Parameters<NonNullable<ClassExtractionConfig['extractName']>>[0]) {
  if (node.type === 'type_spec') return node;
  return node.namedChildren.find((child) => child.type === 'type_spec');
}

export const goClassConfig: ClassExtractionConfig = {
  language: SupportedLanguages.Go,
  typeDeclarationNodes: GO_TYPE_DECLARATION_NODES,
  fileScopeNodeTypes: ['package_clause'],
  extractName(node) {
    return goTypeSpecOf(node)?.childForFieldName('name')?.text;
  },
  extractType(node) {
    const typeNode = goTypeSpecOf(node)?.childForFieldName('type');
    if (typeNode?.type === 'struct_type') return 'Struct';
    if (typeNode?.type === 'interface_type') return 'Interface';
    return undefined;
  },
};
