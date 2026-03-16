from models.user import User
from models.repo import Repo


def process_entities():
    user = User("alice")
    repo = Repo("maindb")
    user.save()
    repo.save()
