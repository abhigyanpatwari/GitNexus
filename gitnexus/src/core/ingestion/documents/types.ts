export interface DocumentDeclaration {
  name: string;
  description: string;
  startIndex: number;
  startLine: number;
  endLine: number;
  level: number;
}

export type DocumentParser = (source: string) => readonly DocumentDeclaration[];
