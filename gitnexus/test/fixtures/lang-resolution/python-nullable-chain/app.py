from user import User
from repo import Repo


def get_user() -> User:
    return User()


def get_repo() -> Repo:
    return Repo()


# Python 3.10+ union: User | None is parsed as binary_operator,
# stored as raw text "User | None" in TypeEnv, then stripNullable resolves it.
def nullable_chain_user() -> None:
    u: User | None = get_user()
    alias = u
    alias.save()


def nullable_chain_repo() -> None:
    r: Repo | None = get_repo()
    alias = r
    alias.save()
