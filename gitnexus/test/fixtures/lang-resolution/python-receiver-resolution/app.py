from user import User
from repo import Repo

def process_entities():
    user: User = User()
    repo: Repo = Repo()
    user.save()
    repo.save()
