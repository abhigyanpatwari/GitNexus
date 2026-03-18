class User:
    def __init__(self, name: str):
        self.name = name

    def save(self) -> None:
        pass

class Repo:
    def __init__(self, name: str):
        self.name = name

    def save(self) -> None:
        pass

def get_users() -> list[User]:
    return [User("alice")]

def get_repos() -> list[Repo]:
    return [Repo("main")]
