from mixins import ClassReceiverMixin, HookMixin


class Worker(HookMixin):
    def helper(self) -> int:
        return 1


class ClassReceiverWorker(ClassReceiverMixin):
    def class_only(self) -> int:
        return 1
