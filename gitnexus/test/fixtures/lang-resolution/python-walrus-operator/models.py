class User:
    def __init__(self, name: str):
        self.name = name

    def save(self) -> bool:
        return True

    def greet(self) -> str:
        return f"Hello, {self.name}"
