from mixins import HookMixin


class WrongArityWorker(HookMixin):
    def helper(self, value: int) -> int:
        return value


class VariadicWrongArityWorker(HookMixin):
    def helper(self, required: int, *args: int) -> int:
        return required
