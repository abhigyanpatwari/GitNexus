from mixins import AmbiguousMixin


class FirstWorker(AmbiguousMixin):
    def run(self) -> int:
        return 1
