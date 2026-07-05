import type Parser from 'tree-sitter';

export type ThriftRole = 'provider' | 'consumer';

export interface ThriftDetection {
  role: ThriftRole;
  serviceName: string;
  methodName: string;
  symbolName: string;
  source: string;
  confidenceWithIdl: number;
  confidenceWithoutIdl: number;
  usesGeneratedServiceMember?: boolean;
}

export interface ThriftLanguagePlugin {
  name: string;
  language: unknown;
  scan(tree: Parser.Tree): ThriftDetection[];
}
