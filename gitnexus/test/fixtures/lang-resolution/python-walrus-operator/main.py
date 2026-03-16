from models import User


def process():
    if (user := User("alice")):
        user.save()
