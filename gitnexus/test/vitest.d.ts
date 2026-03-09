import 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    kuzuDbPath: string;
  }
}
