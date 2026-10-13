__all__ = ("run",)
note = "target renamed"
def inspect():
    __all__ = ["target", "renamed"]
    return __all__
class Metadata:
    __all__ = ["target", "renamed"]
def target(): return 7
def run(): return target()
