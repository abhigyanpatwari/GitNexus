from user import User
from repo import Repo


def get_user() -> User:
    return User()


def get_repo() -> Repo:
    return Repo()


# Walrus operator (:=) creates a named_expression binding.
# Tests that extractPendingAssignment propagates through walrus assignments.
def walrus_chain_user() -> None:
    u: User = get_user()
    # Regular assignment where alias gets type from u (regular chain)
    alias = u
    # Walrus inside condition: w gets type from u via named_expression chain
    if (w := u):
        w.save()
    alias.save()


def walrus_chain_repo() -> None:
    r: Repo = get_repo()
    alias = r
    if (w := r):
        w.save()
    alias.save()
