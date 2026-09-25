def run_sweep():
    pass


def run_then():
    pass


def run_else():
    pass


def run_and():
    pass


def run_or_else():
    pass


def logical_or(override):
    run = override or run_sweep
    run()


def ternary(fast):
    run = run_then if fast else run_else
    run()


def and_or(ready):
    run = ready and run_and or run_or_else
    run()
