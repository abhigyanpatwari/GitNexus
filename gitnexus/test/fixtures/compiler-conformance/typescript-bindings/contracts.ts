export interface Reader {
  read(): string;
}

export class Base {
  read(): string {
    return 'base';
  }
}

export class Other {
  read(): string {
    return 'other';
  }
}
