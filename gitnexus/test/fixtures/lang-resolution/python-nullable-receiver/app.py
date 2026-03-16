from user import User
from repo import Repo

def find_user() -> User | None:
    return User()

def find_repo() -> Repo | None:
    return Repo()

def process_entities():
    user: User | None = find_user()
    user.save()
    repo: Repo | None = find_repo()
    repo.save()
