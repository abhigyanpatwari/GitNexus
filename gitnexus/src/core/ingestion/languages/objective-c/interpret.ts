import type { CaptureMatch, ParsedImport, ParsedTypeBinding, TypeRef } from 'gitnexus-shared';

import { parseObjectiveCTypeDescriptor } from './type-semantics.js';

export function interpretObjectiveCImport(captures: CaptureMatch): ParsedImport | null {
  const source = captures['@import.source']?.text;
  // Angle-bracket imports are not necessarily SDK headers in an iOS
  // workspace: local frameworks conventionally use
  // `#import <FeatureKit/PublicHeader.h>`. Keep them as candidates and let
  // the workspace resolver fail closed when no unique local file exists.
  if (source === undefined) return null;
  return {
    kind: 'wildcard',
    targetRaw: source,
    ...(captures['@import.system'] === undefined ? {} : { isSystem: true }),
  };
}

export function normalizeObjectiveCType(text: string): string {
  return parseObjectiveCTypeDescriptor(text).baseName ?? '';
}

export function interpretObjectiveCTypeBinding(captures: CaptureMatch): ParsedTypeBinding | null {
  const name = captures['@type-binding.name']?.text;
  const type = captures['@type-binding.type']?.text;
  if (name === undefined || type === undefined) return null;

  let source: TypeRef['source'] = 'annotation';
  if (captures['@type-binding.self'] !== undefined) source = 'self';
  else if (captures['@type-binding.parameter'] !== undefined) source = 'parameter-annotation';
  else if (captures['@type-binding.return'] !== undefined) source = 'return-annotation';
  else if (captures['@type-binding.assignment'] !== undefined) source = 'assignment-inferred';

  return {
    boundName: name,
    rawTypeName: normalizeObjectiveCType(type),
    declaredSpelling: type,
    source,
  };
}
