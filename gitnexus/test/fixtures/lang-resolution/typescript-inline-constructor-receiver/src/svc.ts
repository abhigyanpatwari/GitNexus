export class Service {
  constructor(private db: number) {}

  doWork(): number {
    return 1;
  }
}

export class Other {
  doWork(): number {
    return 2;
  }
}

// Factory function, NOT a class — resolves via its return type, and must
// not be mistaken for a construction just because it is called bare.
export function makeOther(db: number): Other {
  return new Other();
}

export class Box<T> {
  unwrap(): number {
    return 3;
  }
}
