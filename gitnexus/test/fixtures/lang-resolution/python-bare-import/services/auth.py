import user

def authenticate():
    svc = user.UserService()
    svc.execute()
