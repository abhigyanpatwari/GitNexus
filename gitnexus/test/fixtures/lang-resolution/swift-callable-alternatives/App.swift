func runSweep() {}
func runThen() {}
func runElse() {}

func nilCoalescing(override: (() -> Void)?) {
  let run = override ?? runSweep
  run()
}

func runLeft() {}

func callableLeft(fallback: @escaping () -> Void) {
  let run = runLeft ?? fallback
  run()
}

func ternary(fast: Bool) {
  let run = fast ? runThen : runElse
  run()
}
