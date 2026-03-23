from user import User

def process(data: dict[str, User]):
    for key, user in data.items():
        user.save()
