from models import get_users, get_repos

def process_users():
    for user in get_users():
        user.save()

def process_repos():
    for repo in get_repos():
        repo.save()
