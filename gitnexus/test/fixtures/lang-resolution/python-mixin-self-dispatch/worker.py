from mixins import HookMixin


class Worker(HookMixin):
    def helper(self) -> int:
        return 1
