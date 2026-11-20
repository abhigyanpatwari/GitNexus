import path from 'node:path';

/** File extensions for which ingestion indexes headings and links. */
export function isIndexedDocumentationPath(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext === '.md' || ext === '.mdx';
}
