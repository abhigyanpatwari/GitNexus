from models import User, Repo

def main():
    user = User()
    user.save()

    repo = Repo()
    repo.persist()
