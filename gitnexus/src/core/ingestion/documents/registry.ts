import type { DocumentParser } from './types.js';
import { extractXamlDeclarations } from './xaml.js';

export const DOCUMENT_PARSERS: ReadonlyMap<string, DocumentParser> = new Map([
  ['.xaml', extractXamlDeclarations],
]);
