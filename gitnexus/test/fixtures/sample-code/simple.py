def public_function(x: int, y: int) -> int:
    """A public function."""
    return x + y

def _private_helper(data: str) -> str:
    """A private helper function."""
    return data.strip()

class Calculator:
    def add(self, a: int, b: int) -> int:
        return a + b

    def _reset(self) -> None:
        pass
