class User:
    def __init__(self, name):
        self.name = name

    def save(self):
        pass

    def greet(self):
        return f"Hello, {self.name}"
