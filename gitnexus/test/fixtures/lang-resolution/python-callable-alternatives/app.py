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


# A comparison branch of `or` yields a bool, never what it compares against:
# none of these may reach `run`; the `self.fallback` branch still flows.
class Handlers:
    @staticmethod
    def run():
        pass


def comparison_branch(x, fb):
    h = x.kind == Handlers.run or fb
    h()


class Machine:
    def run(self):
        pass

    def fallback(self):
        pass

    def self_comparison(self):
        h = self.state != self.run or self.fallback
        h()

    def bare_comparison(self, run):
        h = self.state != run or self.fallback
        h()
