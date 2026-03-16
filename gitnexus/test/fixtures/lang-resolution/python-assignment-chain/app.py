from user import User
from repo import Repo

def get_user() -> User:
    return User()

def get_repo() -> Repo:
    return Repo()

def process():
    u: User = get_user()
    alias = u
    alias.save()

    r: Repo = get_repo()
    r_alias = r
    r_alias.save()
