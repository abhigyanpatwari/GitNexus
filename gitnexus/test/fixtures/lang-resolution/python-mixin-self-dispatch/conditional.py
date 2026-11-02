from mixins import HookMixin


class ConditionalWorker(HookMixin):
    if True:
        def helper(instance) -> int:
            return 2
