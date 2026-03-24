from models import User

def get_user(name: str) -> User:
    return User(name)
