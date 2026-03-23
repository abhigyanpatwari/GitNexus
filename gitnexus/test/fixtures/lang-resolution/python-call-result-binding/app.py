from service import get_user

def process_user():
    user = get_user("alice")
    user.save()
