from service import UserService


def process_user():
    svc = UserService()
    svc.get_user().save()
