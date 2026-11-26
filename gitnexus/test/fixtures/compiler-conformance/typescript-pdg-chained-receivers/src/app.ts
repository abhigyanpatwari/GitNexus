export class Mid {
  compute(v: number): number {
    return v * 3;
  }
}

export class Inner {
  compute(v: number): number {
    return v * 2;
  }
  mid(): Mid {
    return new Mid();
  }
}

export class Outer {
  inner(): Inner {
    return new Inner();
  }
}

export function makeOuter(): Outer {
  return new Outer();
}

export function runLocalConst(x: number): number {
  const localConst = new Outer();
  const r = localConst.inner().compute(x);
  return r;
}

export function runCallResultReceiver(x: number): number {
  const r = makeOuter().inner().compute(x);
  return r;
}

export function runThreeLink(x: number): number {
  const threeLink = new Outer();
  const r = threeLink.inner().mid().compute(x);
  return r;
}

export class AnnotatedFieldCaller {
  private annotated: Outer = new Outer();
  run(x: number): number {
    const r = this.annotated.inner().compute(x);
    return r;
  }
}

export class InferredFieldCaller {
  private inferred = new Outer();
  run(x: number): number {
    const r = this.inferred.inner().compute(x);
    return r;
  }
}

export class CtorAssignedAnnotatedCaller {
  private ctorTyped: Outer;
  constructor() {
    this.ctorTyped = new Outer();
  }
  run(x: number): number {
    const r = this.ctorTyped.inner().compute(x);
    return r;
  }
}

export class CtorAssignedInferredCaller {
  private ctorUntyped;
  constructor() {
    this.ctorUntyped = new Outer();
  }
  run(x: number): number {
    const r = this.ctorUntyped.inner().compute(x);
    return r;
  }
}
