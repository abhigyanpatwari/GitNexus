def greet(name: str, greeting: str = "Hello") -> str:
    return greeting + ", " + name

def search(query: str, limit: int = 10) -> list:
    return []

def process():
    greet("alice")
    greet("bob", "Hi")
    search("test")
    search("test", 5)
