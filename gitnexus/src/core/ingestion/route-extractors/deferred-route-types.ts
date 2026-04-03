import type { SupportedLanguages } from 'gitnexus-shared';

export interface DeferredRouteCandidate {
  kind: string;
  language: SupportedLanguages;
  filePath: string;
  lineNumber: number;
}
