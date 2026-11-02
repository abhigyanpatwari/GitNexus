from mixins import AmbiguousMixin


class SecondWorker(AmbiguousMixin):
    def run(self) -> int:
        return 2
