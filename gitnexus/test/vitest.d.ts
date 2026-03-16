import 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    lbugDbPath: string;
  }
}
