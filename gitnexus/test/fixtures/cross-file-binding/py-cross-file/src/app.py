from models import get_user

def run():
    u = get_user()
    u.save()
    u.get_name()
