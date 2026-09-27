from mixins import (
    ArgumentForwardingMixin,
    ArgumentShapeMixin,
    ClassReceiverMixin,
    FieldShadowMixin,
    GenericMixin,
    HookMixin,
    LifecycleReceiverMixin,
    MroOrderMixin,
    NestedClassReceiverMixin,
    PrivateNameMixin,
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


class OrderX:
    def order_hook(self) -> int:
        return 1


class OrderA(OrderX):
    pass


class OrderB:
    def order_hook(self) -> int:
        return 2


class OrderedWorker(MroOrderMixin, OrderA, OrderB):
    pass


class ShadowBlocker:
    shadow_hook = None


class ShadowProvider:
    def shadow_hook(self) -> int:
        return 1


class ShadowWorker(FieldShadowMixin, ShadowBlocker, ShadowProvider):
    pass


class LifecycleReceiverWorker(LifecycleReceiverMixin):
    def lifecycle_hook(self) -> int:
        return 1

    def new_hook(self) -> int:
        return 1


class GenericWorker(GenericMixin):
    def class_only(self) -> int:
        return 1


class CompatibleArgumentBase:
    def keyword_only_target(self, value: int) -> int:
        return value


class ArgumentShapeWorker(ArgumentShapeMixin, CompatibleArgumentBase):
    def keyword_only_target(self, *, value: int) -> int:
        return value

    def positional_only_target(self, value: int, /) -> int:
        return value

    def required_keyword_target(self, value: int = 0, *, required: int) -> int:
        return value + required


class ArgumentForwardingWorker(ArgumentForwardingMixin):
    def forward_target(self, value: int) -> int:
        return value


class PrivateNameWorker(PrivateNameMixin):
    def __private_hook(self) -> int:
        return 1
