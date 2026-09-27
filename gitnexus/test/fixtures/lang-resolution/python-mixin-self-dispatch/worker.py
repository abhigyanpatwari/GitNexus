from mixins import (
    ClassReceiverMixin,
    HookMixin,
    NestedClassReceiverMixin,
    VariadicPseudoReceiverMixin,
)


class Worker(HookMixin):
    def helper(instance) -> int:
        return 1


class ClassReceiverWorker(ClassReceiverMixin):
    def class_only(self) -> int:
        return 1


class VariadicPseudoReceiverWorker(VariadicPseudoReceiverMixin):
    def variadic_target(self) -> int:
        return 1


class NestedClassReceiverWorker(NestedClassReceiverMixin):
    def instance_only(self) -> int:
        return 1
