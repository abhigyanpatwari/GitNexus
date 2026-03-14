declare module '@ladybugdb/wasm-core' {
  export function init(): Promise<void>;
  export class Database {
    constructor(path: string);
    close(): Promise<void>;
  }
  export class Connection {
    constructor(db: Database);
    query(cypher: string): Promise<QueryResult>;
    close(): Promise<void>;
  }
  export interface QueryResult {
    hasNext(): Promise<boolean>;
    getNext(): Promise<any>;
  }
  export const FS: {
    writeFile(path: string, data: string): Promise<void>;
    unlink(path: string): Promise<void>;
  };
  const lbug: {
    init: typeof init;
    Database: typeof Database;
    Connection: typeof Connection;
    FS: typeof FS;
  };
  export default lbug;
}
