class City:
    def __init__(self, name: str):
        self.name = name

    def save(self) -> bool:
        return True

class Address:
    city: City

    def __init__(self, city: City):
        self.city = city

    def get_city(self) -> City:
        return self.city

class User:
    address: Address

    def __init__(self, address: Address):
        self.address = address
