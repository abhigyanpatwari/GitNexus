from impl import SqlRepository

def process():
    repo = SqlRepository()
    user = repo.find(42)
    repo.save(user)
