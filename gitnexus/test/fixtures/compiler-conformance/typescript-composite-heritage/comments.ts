class Base<A, B> {
  put(a: A, b: B): void {}
}

export class BlockComment extends Base<string /* { ], > */, number> {
  override put(a: string, b: number): void {}
}

export class LineComment extends Base<string // } ] > ,
  , number> {
  override put(a: string, b: number): void {}
}

export class QuotedToken extends Base<'/*' | '//', number> {
  override put(a: '/*' | '//', b: number): void {}
}
