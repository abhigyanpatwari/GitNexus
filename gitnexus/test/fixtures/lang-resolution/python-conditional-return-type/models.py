class User:
    def save(self):
        return True


class Other:
    def save(self):
        return False


def make_user() -> User:
    return User()


def make_other() -> Other:
    return Other()
