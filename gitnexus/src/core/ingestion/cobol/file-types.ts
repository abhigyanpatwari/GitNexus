import path from 'node:path';

// Keep detection shared without loading the analyze-only language providers.
export const COBOL_EXTENSIONS = new Set(['.cob', '.cbl', '.cobol', '.cpy', '.copybook']);
export const JCL_EXTENSIONS = new Set(['.jcl', '.job', '.proc']);

/** Includes COBOL programs and copybooks accepted by ingestion. */
export function isCobolFile(filePath: string): boolean {
  return COBOL_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

/** Includes job and procedure aliases accepted by JCL ingestion. */
export function isJclFile(filePath: string): boolean {
  return JCL_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}
