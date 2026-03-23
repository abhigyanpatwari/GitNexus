from models.user import User
from models.repo import Repo


def process(x):
    match x:
        case User() as u:
            u.save()  # should resolve to User#save, not Repo#save
