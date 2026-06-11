// AC1 fixture (#2081 M1): ten TS functions mixing the control-flow constructs
// the CFG visitor handles. Deliberately NO unreachable/dead code (no statement
// after an unconditional return/throw), so the AC2 property — every BasicBlock
// reachable from its function ENTRY — holds for every function here.
//
// Edit with care: the CFG snapshot (cfg-snapshot.test.ts) keys block/edge
// counts off this exact source, and the per-function start lines anchor it.

export function straight(): void {
  a();
  b();
}

export function withIf(x: boolean): void {
  if (x) {
    a();
  } else {
    b();
  }
  c();
}

export function withElseIf(x: number): void {
  if (x === 1) {
    a();
  } else if (x === 2) {
    b();
  } else {
    c();
  }
  d();
}

export function withWhile(x: number): void {
  while (x > 0) {
    step();
  }
  done();
}

export function withFor(n: number): void {
  for (let i = 0; i < n; i++) {
    step();
  }
  done();
}

export function withForOf(xs: number[]): void {
  for (const x of xs) {
    use(x);
  }
  done();
}

export function withSwitch(x: number): void {
  switch (x) {
    case 1:
      one();
      break;
    case 2:
      two();
      break;
    default:
      other();
  }
  tail();
}

export function withTry(): void {
  try {
    work();
  } catch (e) {
    oops();
  } finally {
    fin();
  }
  after();
}

export function withReturn(x: boolean): number {
  if (x) {
    return 1;
  }
  return 2;
}

export function withNested(xs: number[]): void {
  for (const x of xs) {
    if (x > 0) {
      p();
    } else {
      q();
    }
  }
  end();
}

// M2 additions (#2082 U5): an early-exit-through-finally and a shadowing case —
// the two reaching-defs acceptance shapes the original ten functions lacked.
// Their CFG topology exercises U2's finally threading; their facts pin R4/R9.

export function withEarlyExitFinally(flag: boolean): number {
  let val = 1;
  try {
    if (flag) {
      return probe(val);
    }
    work();
  } finally {
    val = 2;
  }
  return val;
}

export function withShadowing(): void {
  let s = 1;
  {
    let s = 2;
    s = s + 1;
    use(s);
  }
  s = s + 1;
  done2(s);
}

declare function a(): void;
declare function b(): void;
declare function c(): void;
declare function d(): void;
declare function step(): void;
declare function done(): void;
declare function use(x: number): void;
declare function one(): void;
declare function two(): void;
declare function other(): void;
declare function tail(): void;
declare function work(): void;
declare function oops(): void;
declare function fin(): void;
declare function after(): void;
declare function p(): void;
declare function q(): void;
declare function end(): void;
declare function probe(n: number): number;
declare function done2(n: number): void;
