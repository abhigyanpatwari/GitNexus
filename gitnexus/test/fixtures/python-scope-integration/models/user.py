"""User model — base class with id and name."""


class User:
    """A user with an id and display name."""

    def __init__(self, user_id: int, name: str):
        self.user_id = user_id
        self.name = name

    def display_name(self) -> str:
        return self.name


class Admin(User):
    """Admin extends User with elevated permissions."""

    def __init__(self, user_id: int, name: str, level: int):
        super().__init__(user_id, name)
        self.level = level

    def can_delete(self) -> bool:
        return self.level >= 5
