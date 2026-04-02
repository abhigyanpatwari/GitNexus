export type SpringRoutePathExpression =
  | { kind: 'literal'; value: string }
  | { kind: 'identifier'; name: string }
  | { kind: 'field-access'; ownerPath: string[]; fieldName: string };

export interface ExtractedSpringJavaRouteCandidate {
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

export type ExtractedDeferredRouteCandidate = ExtractedSpringJavaRouteCandidate;
