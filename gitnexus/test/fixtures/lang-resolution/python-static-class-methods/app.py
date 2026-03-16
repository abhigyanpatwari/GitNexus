from service import UserService, AdminService


def process():
    user = UserService.find_user("alice")
    UserService.create_user("bob")
    svc = UserService.from_config({})

    AdminService.find_user("charlie")
    AdminService.delete_user("charlie")
