from mixins import HookMixin


class WrongArityWorker(HookMixin):
    def helper(self, value: int) -> int:
        return value
