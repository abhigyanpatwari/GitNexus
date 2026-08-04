from models.user import User
from models.repo import Repo


def process_inline(db):
    return User(db).save()


def process_twostep(db):
    r = Repo(db)
    return r.save()
