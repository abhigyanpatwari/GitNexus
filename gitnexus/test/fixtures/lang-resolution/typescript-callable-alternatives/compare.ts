// A branch of `||` / `??` / `?:` that is a comparison yields a boolean, never
// the member it compares against. None of these bindings may reach `run`.
export class Handlers {
  static run(x: unknown): void {}
  static fallback(x: unknown): void {}
}

export async function comparisonBranch(x: { kind: unknown }, fb: (x: unknown) => void) {
  const h = x.kind === Handlers.run || fb;
  h(x);
}

export async function staticComparison(run: unknown, fb: (x: unknown) => void) {
  const h = Handlers.fallback === run || fb;
  h(run);
}

export class Machine {
  state: unknown;
  run(): void {}
  fallback(): void {}

  thisComparison() {
    const h = this.state !== this.run || this.fallback;
    h();
  }

  bareComparison(run: unknown) {
    const h = this.state !== run ?? this.fallback;
    h();
  }

  arithmeticBranch(run: number) {
    const h = this.state + run || this.fallback;
    h();
  }

  ternaryComparison(fast: boolean) {
    const h = fast ? this.state === this.run : this.fallback;
    h();
  }
}
