class HookMixin:
    def first(self) -> int:
        return self.helper()

    def second(self) -> int:
        return self.helper()

    def renamed(instance) -> int:
        return instance.helper()

    def missing(self) -> int:
        return self.missing_target()


class AnnotatedCaller:
    def call_annotated(self, other: HookMixin) -> int:
        return other.helper()


class ClassReceiverMixin:
    @classmethod
    def invoke(receiver, value: int) -> int:
        return receiver.class_only(value)


class AmbiguousMixin:
    def dispatch(self) -> int:
        return self.run()


class VariadicPseudoReceiverMixin:
    def variadic_dispatch(*args) -> int:
        return args.variadic_target()


class NestedClassReceiverMixin:
    @classmethod
    def invoke_nested(owner) -> int:
        def inner() -> int:
            return owner.instance_only()

        return inner()


class MroOrderMixin:
    def dispatch_order(self) -> int:
        return self.order_hook()


class FieldShadowMixin:
    def dispatch_shadow(self) -> int:
        return self.shadow_hook()


class LifecycleReceiverMixin:
    def __init_subclass__(cls) -> int:
        return cls.lifecycle_hook()

    def __new__(cls) -> int:
        cls.allocate()
        return cls.new_hook()

    @classmethod
    def allocate(cls) -> int:
        return 1


class GenericMixin:
    def __class_getitem__(cls, item: object) -> int:
        return cls.class_only()


class ArgumentShapeMixin:
    def positional_to_keyword_only(self) -> int:
        return self.keyword_only_target(1)

    def keyword_to_positional_only(self) -> int:
        return self.positional_only_target(value=1)

    def positional_missing_required_keyword(self) -> int:
        return self.required_keyword_target(1)


class ArgumentForwardingMixin:
    def forward_first(self, value: int) -> int:
        return self.forward_target(value)

    def forward_second(self, value: int) -> int:
        return self.forward_target(value)


class PrivateNameMixin:
    def dispatch_private(self) -> int:
        return self.__private_hook()


class AbstractBoundaryMixin:
    def dispatch_abstract(self) -> int:
        return self.abstract_hook()


class DuplicateDefinitionMixin:
    def dispatch_duplicate(self) -> int:
        return self.duplicate_hook(1)
