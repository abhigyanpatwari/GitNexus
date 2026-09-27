class HookMixin:
    def first(self) -> int:
        return self.helper()

    def second(self) -> int:
        return self.helper()

    def missing(self) -> int:
        return self.missing_target()


class AmbiguousMixin:
    def dispatch(self) -> int:
        return self.run()
