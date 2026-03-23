from models import User

def process_user(user: User):
    user.address.save()
