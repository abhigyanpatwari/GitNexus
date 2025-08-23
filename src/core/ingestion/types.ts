/**
 * Common types used across ingestion processors
 */

export interface ParsedAST {
  tree: any;
}

export interface ImportMap {
  [importingFile: string]: {
    [localName: string]: {
      targetFile: string;
      exportedName: string;
      importType: 'default' | 'named' | 'namespace' | 'dynamic';
    }
  }
}

export interface ParsedDefinition {
  name: string;
  type: 'function' | 'class' | 'method' | 'variable' | 'import' | 'interface' | 'type' | 'decorator';
  startLine: number;
  endLine?: number;
  parameters?: string[] | undefined;
  returnType?: string | undefined;
  accessibility?: 'public' | 'private' | 'protected';
  isStatic?: boolean | undefined;
  isAsync?: boolean | undefined;
  parentClass?: string | undefined;
  decorators?: string[] | undefined;
  extends?: string[] | undefined;
  implements?: string[] | undefined;
  importPath?: string | undefined;
  exportType?: 'named' | 'default' | 'namespace';
  docstring?: string | undefined;
}

export interface ParallelParsingResult {
  filePath: string;
  definitions: ParsedDefinition[];
  ast: ParsedAST;
  success: boolean;
  error?: string;
}
