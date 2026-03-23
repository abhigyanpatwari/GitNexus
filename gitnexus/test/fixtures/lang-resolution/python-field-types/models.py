class Address:
    city: str

    def save(self):
        pass

class User:
    name: str
    address: Address

    def greet(self) -> str:
        return self.name
