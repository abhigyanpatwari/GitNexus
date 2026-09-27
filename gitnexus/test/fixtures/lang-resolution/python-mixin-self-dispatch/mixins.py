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
