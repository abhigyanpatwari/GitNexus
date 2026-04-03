import { SupportedLanguages } from 'gitnexus-shared';
import type { DeferredRouteCandidate } from './deferred-route-types.js';

export type SpringRoutePathExpression =
  | { kind: 'literal'; value: string }
  | { kind: 'identifier'; name: string }
  | { kind: 'field-access'; ownerPath: string[]; fieldName: string };

export interface ExtractedSpringJavaRouteCandidate extends DeferredRouteCandidate {
  kind: 'spring-java';
  language: SupportedLanguages.Java;
  filePath: string;
  controllerName: string;
  methodName: string;
  httpMethod: string;
  classPathExpression: SpringRoutePathExpression | null;
  methodPathExpression: SpringRoutePathExpression | null;
  hasExplicitClassPath: boolean;
  hasExplicitMethodPath: boolean;
  lineNumber: number;
}
