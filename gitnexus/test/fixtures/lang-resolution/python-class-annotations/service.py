from user import User
from repo import Repo

# File-level class annotations (no default)
active_user: User
active_repo: Repo

def process():
    active_user.save()
    active_repo.save()
